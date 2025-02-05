const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const API_TOKENS = process.env.API_TOKENS.split(',');
const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

const app = express();
app.use(bodyParser.json());

const accountTrades = new Map();
const zone = new Map();
const condition = new Map();
const confirmation = new Map();

const PING_INTERVAL = 30000;
let wsConnections = [];

const sendToWebSocket = (ws, data) => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
};

const placeTrade = async (ws, accountId, trade) => {
  const tradeId = uuidv4();
  const customTradeId = `${accountId}_${tradeId}`;
  
  if (!accountTrades.has(accountId)) {
    accountTrades.set(accountId, new Map());
  }

  const tradesForAccount = accountTrades.get(accountId);
  tradesForAccount.set(tradeId, {
    symbol: "frxXAUUSD",
    call: trade.call,
    stake: trade.stake,
    martingaleStep: trade.martingaleStep || 0,
    maxMartingaleSteps: 2,
    contract_id: null,
    parentTradeId: trade.parentTradeId || null
  });

  console.log("Account ID:", accountId);
  console.log("Trade ID:", tradeId);
  console.log("Custom Trade ID before placing trade:", customTradeId);


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
      custom_trade_id: customTradeId 
    }
  });
};

const handleTradeResult = async (contract, accountId, tradeId) => {
  console.log(`Trade results proccessed for Account ID - ${accountId}`);
  
  const tradesForAccount = accountTrades.get(accountId);
  if (!tradesForAccount) return;

  const trade = tradesForAccount.get(tradeId);
  if (!trade) return;

  if (contract.profit < 0) {
    if (trade.martingaleStep < trade.maxMartingaleSteps) {
      const newStake = trade.stake * 2;
      const ws = wsConnections.find(conn => conn.accountId === accountId);

      await placeTrade(ws, accountId, {
        symbol: trade.symbol,
        call: trade.call,
        stake: newStake,
        martingaleStep: trade.martingaleStep + 1,
        parentTradeId: tradeId
      });

      console.log(`[${accountId}] Martingale step ${trade.martingaleStep + 1} for trade chain ${trade.parentTradeId || tradeId}`);
    } else {
      console.log(`[${accountId}] Max Martingale steps reached for trade chain ${trade.parentTradeId || tradeId}`);
    }
  }

  tradesForAccount.delete(tradeId);
};

const createWebSocketConnections = () => {
  wsConnections.forEach(ws => ws?.close());
  
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
    
        if (response.msg_type === "buy" && response.buy.contract_id) {
          console.log(response);
          const customTradeId = response.passthrough?.custom_trade_id;
          console.log("Custom Trade ID:", customTradeId);
          
          if (customTradeId) {
            const [accountId, tradeId] = customTradeId.split("_");
            if (accountTrades.has(accountId)) {
              const tradesForAccount = accountTrades.get(accountId);
              if (tradesForAccount.has(tradeId)) {
                tradesForAccount.get(tradeId).contract_id = response.contract_id;
                console.log(tradesForAccount.get(tradeId));
              }
            }
          }
        }
    
        if (response.msg_type === "proposal_open_contract") {
          const contract = response.proposal_open_contract;
          
          if (!contract || !contract.contract_id) return;
          
          if(contract.status !== 'open'){
            console.log(contract);
            
            for (const [accountId, trades] of accountTrades) {
              console.log(accountId);
              
              for (const [tradeId, trade] of trades) {
                console.log(tradeId);
                console.log(trade);
                if (trade.contract_id === contract.contract_id) {
                  handleTradeResult(contract, accountId, tradeId);
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

const processTradeSignal = (message, call) => {
  API_TOKENS.forEach(accountId => {
    if (!zone.has(accountId)) zone.set(accountId, null);
    if (!condition.has(accountId)) condition.set(accountId, null);
    if (!confirmation.has(accountId)) confirmation.set(accountId, null);

    switch(message) {
      case 'ZONE': zone.set(accountId, call); break;
      case 'CONDITION': condition.set(accountId, call); break;  
      case 'CONFIRMATION': confirmation.set(accountId, call); break;
    }
    const zoneCall = zone.get(accountId)
    const conditionCall = condition.get(accountId)
    const confirmationCall = confirmation.get(accountId)
    console.log(`The Zone is ${zoneCall}, Condition is ${conditionCall}, confirmation is ${confirmationCall} for Account iD - ${accountId}`);
    
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
