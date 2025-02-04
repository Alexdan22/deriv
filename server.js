const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const API_TOKENS = process.env.API_TOKENS.split(',');
const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

const app = express();
app.use(bodyParser.json());

// Account-specific state tracking
const accountTrades = new Map();
const zone = new Map();
const condition = new Map();
const confirmation = new Map();

const PING_INTERVAL = 30000;
let wsConnections = [];

// Helper: Send data over WebSocket
const sendToWebSocket = (ws, data) => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
};

// Trade placement with account isolation
const placeTrade = async (ws, accountId, trade) => {
  const tradeId = uuidv4();
  
  if (!accountTrades.has(accountId)) {
    accountTrades.set(accountId, new Map());
  }

  const tradesForAccount = accountTrades.get(accountId);
  tradesForAccount.set(tradeId, {
    symbol: "frxXAUUSD",
    call: trade.call,
    stake: trade.stake,
    martingaleStep: 0,
    maxMartingaleSteps: 2,
  });

  sendToWebSocket(ws, {
    buy: "1",
    price: trade.stake,
    parameters: {
      amount: trade.stake,
      basis: "stake",
      contract_type: trade.call === "call" ? "CALL" : "PUT",
      currency: "USD",
      duration: 5,
      duration_unit: "m",
      symbol: "frxXAUUSD",
    },
    passthrough: { 
      custom_trade_id: `${accountId}_${tradeId}` 
    }
  });

  console.log(`[${accountId}] Trade placed: ${tradeId}`);
};

// Handle trade outcomes with account isolation
const handleTradeResult = async (contract, accountId) => {
  if (!contract || !accountId) return;
  console.log('Account id is ' + accountId);
  

  const tradesForAccount = accountTrades.get(accountId);
  if (!tradesForAccount) return;

  const tradeId = contract.echo_req?.custom_trade_id?.split('_')[1];
  if (!tradeId) return;

  const trade = tradesForAccount.get(tradeId);
  if (!trade) return;

  if (contract.is_expired || contract.is_sold) {
    console.log('I was logged till contract expiry');
    
    if (contract.profit < 0 && trade.martingaleStep < trade.maxMartingaleSteps) {
      const newStake = trade.stake * 2;
      const ws = wsConnections.find(conn => conn.accountId === accountId);
      await placeTrade(ws, accountId, { 
        ...trade, 
        stake: newStake,
        martingaleStep: trade.martingaleStep + 1 
      });
      console.log(`[${accountId}] Martingale step ${trade.martingaleStep + 1}`);
    }
    tradesForAccount.delete(tradeId);
  }
};

// WebSocket connection management
const createWebSocketConnections = () => {
  // Cleanup existing connections
  wsConnections.forEach(ws => ws?.close());
  
  // Create new connections
  wsConnections = API_TOKENS.map(apiToken => {
    const ws = new WebSocket(WEBSOCKET_URL);
    ws.accountId = apiToken;

    ws.on('open', () => {
      console.log(`[${apiToken}] Connected`);
      sendToWebSocket(ws, { authorize: apiToken });
      setInterval(() => {
        sendToWebSocket(ws, { ping: 1 });
        sendToWebSocket(ws, { proposal_open_contract: 1, subscribe: 1 });
      }, PING_INTERVAL);
    });

    ws.on("message", (data) => {
      try {
        const response = JSON.parse(data);
    
        // Handle "buy" responses
        if (response.msg_type === "buy") {
          const passthrough = response.echo_req?.passthrough;
          if (passthrough?.custom_trade_id) {
            const [accountId, tradeId] = passthrough.custom_trade_id.split("_");
            console.log(`[${accountId}] Buy confirmed: ${tradeId}`);
          } else if (response.error) {
            console.error("Buy failed:", response.error.message);
          }
        }
    
        // Handle contract updates
        if (response.msg_type === "proposal_open_contract") {
          const contract = response.proposal_open_contract;
          if (!contract) {
            return;
          }
    
          const passthrough = contract.echo_req?.passthrough;
          if (contract.status !== 'open') {
            console.log('Trade ended successfully processing results');
            
            console.log(contract);
            const [accountId, tradeId] = passthrough.custom_trade_id.split("_");
            handleTradeResult(contract, accountId);
          }
        }
    
      } catch (error) {
        console.error("Message processing failed:", error);
      }
    });

    ws.on('close', () => {
      console.log(`[${apiToken}] Connection closed, reconnecting...`);
      setTimeout(createWebSocketConnections, 10000);
    });

    ws.on('error', error => 
      console.error(`[${apiToken}] WebSocket error:`, error));

    return ws;
  });
};

// Webhook processing with account isolation
const processTradeSignal = (message, call) => {
  API_TOKENS.forEach(accountId => {
    // Initialize account state
    if (!zone.has(accountId)) zone.set(accountId, null);
    if (!condition.has(accountId)) condition.set(accountId, null);
    if (!confirmation.has(accountId)) confirmation.set(accountId, null);

    // Update state machine
    switch(message) {
      case 'ZONE': zone.set(accountId, call); break;
      case 'CONDITION': condition.set(accountId, call); break;
      case 'CONFIRMATION': confirmation.set(accountId, call); break;
    }

    // Trigger trade when all conditions match
    if (
      zone.get(accountId) === call &&
      condition.get(accountId) === call &&
      confirmation.get(accountId) === call
    ) {
      const ws = wsConnections.find(conn => conn.accountId === accountId);
      if (ws) {
        placeTrade(ws, accountId, {
          symbol: 'frxXAUUSD',
          call,
          stake: 10
        });
        condition.set(accountId, null);
        confirmation.set(accountId, null);
      }
    }
  });
};

// Server setup
app.post('/webhook', (req, res) => {
  const { symbol, call, message } = req.body;
  if (!symbol || !call || !message) {
    return res.status(400).send('Invalid payload');
  }
  processTradeSignal(message, call);
  res.send('Signal processed');
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
  createWebSocketConnections();
});