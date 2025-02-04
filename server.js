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
    martingaleStep: trade.martingaleStep || 0, // Default to 0 if not provided
    maxMartingaleSteps: 2,
    contract_id: null, // Populated later
    parentTradeId: trade.parentTradeId || null // Track parent for chaining
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
const handleTradeResult = async (contract, accountId, tradeId) => {
  const tradesForAccount = accountTrades.get(accountId);
  if (!tradesForAccount) return;

  const trade = tradesForAccount.get(tradeId);
  if (!trade) return;

  if (contract.profit < 0) {
    if (trade.martingaleStep < trade.maxMartingaleSteps) {
      const newStake = trade.stake * 2;
      const ws = wsConnections.find(conn => conn.accountId === accountId);

      // Place new Martingale trade with incremented step
      await placeTrade(ws, accountId, {
        symbol: trade.symbol,
        call: trade.call,
        stake: newStake,
        martingaleStep: trade.martingaleStep + 1,
        parentTradeId: tradeId // Link to parent trade
      });

      console.log(`[${accountId}] Martingale step ${trade.martingaleStep + 1} for trade chain ${trade.parentTradeId || tradeId}`);
    } else {
      console.log(`[${accountId}] Max Martingale steps reached for trade chain ${trade.parentTradeId || tradeId}`);
    }
  }

  // Cleanup: Remove the trade from tracking once processed
  tradesForAccount.delete(tradeId);
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
        if (response.msg_type === "buy" && response.contract_id) {
          const passthrough = response.passthrough || response.echo_req?.passthrough;
          if (passthrough?.custom_trade_id) {
            const [accountId, tradeId] = passthrough.custom_trade_id.split("_");
            const tradesForAccount = accountTrades.get(accountId);
            if (tradesForAccount && tradesForAccount.has(tradeId)) {
              const trade = tradesForAccount.get(tradeId);
              trade.contract_id = response.contract_id; // Store contract_id
              tradesForAccount.set(tradeId, trade);
            }
          }
        }
    
        // Handle contract updates
        if (response.msg_type === "proposal_open_contract") {
          const contract = response.proposal_open_contract;
          if (!contract || !contract.contract_id) return;
        
          // Find the trade by contract_id
          for (const [accId, trades] of accountTrades) {
            for (const [tradeId, trade] of trades) {
              if (trade.contract_id === contract.contract_id) {
                if(contract.status !== 'open'){
                  handleTradeResult(contract, accId, tradeId);
                  return;
                }
              }
            }
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