const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');

require('dotenv').config(); // Load environment variables from .env file

const API_TOKENS = process.env.API_TOKENS.split(',');
const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

const app = express();
app.use(bodyParser.json());

const trades = new Map();
let zone = null, condition = null, confirmation = null;

const PING_INTERVAL = 30000;
let wsConnections = [];

const sendToWebSocket = (ws, data) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
};

const parseDuration = (duration) => {
  const unit = duration.slice(-1);
  const value = parseInt(duration.slice(0, -1), 10);
  return unit === 't' ? value : unit === 's' ? value / 60 : unit === 'm' ? value : unit === 'h' ? value * 60 : unit === 'd' ? value * 1440 : Infinity;
};

const placeTrade = (ws, trade) => {
  try {
    sendToWebSocket(ws, {
      buy: 1,
      price: trade.stake,
      parameters: {
        amount: trade.stake,
        basis: 'stake',
        contract_type: trade.call === 'call' ? 'CALL' : 'PUT',
        currency: 'USD',
        duration: 5,
        duration_unit: 'm',
        symbol: trade.symbol,
      },
    });
  } catch (error) {
    console.error(`Error placing trade for ${trade.symbol}:`, error);
  }
};

const handleTradeResult = async (contract) => {
  const tradeKey = `frxXAUUSD-${contract.contract_id}`;
  const trade = trades.get(tradeKey);

  if (trade) {
    if (contract.is_expired || contract.is_sold) {
      const tradePnL = contract.profit;
      if (tradePnL <= 0 && trade.martingaleStep < trade.maxMartingaleSteps) {
        trade.stake *= 2;
        trade.martingaleStep++;
        placeTrade(wsConnections[0], trade);
      } else {
        trades.delete(tradeKey);
      }
    }
  }
};

const createWebSocketConnections = () => {
  wsConnections.forEach(ws => ws.close()); // Close existing connections
  wsConnections = API_TOKENS.map((apiToken) => {
    const ws = new WebSocket(WEBSOCKET_URL);

    ws.on('open', () => {
      console.log(`Connected to Deriv API for token: ${apiToken}`);
      sendToWebSocket(ws, { authorize: apiToken });
      setInterval(() => sendToWebSocket(ws, { ping: 1 }), PING_INTERVAL);
    });

    ws.on('message', (data) => {
      const response = JSON.parse(data);
      if (response.msg_type === 'buy') {
        const tradeKey = `frxXAUUSD-${response.buy.contract_id}`;
        if (!trades.has(tradeKey)) {
          trades.set(tradeKey, { symbol: 'frxXAUUSD', call: response.buy.call, stake: response.buy.stake, martingaleStep: 0, maxMartingaleSteps: 1 });
        }
      }
      if (response.msg_type === 'proposal_open_contract') {
        handleTradeResult(response.proposal_open_contract);
      }
    });

    ws.on('close', () => setTimeout(createWebSocketConnections, 5000));
    ws.on('error', (error) => console.error('WebSocket error:', error));
    return ws;
  });
};

const processTradeSignal = (message, call) => {
  if (message === 'ZONE') zone = call;
  if (message === 'CONDITION') condition = call;
  if (message === 'CONFIRMARION') confirmation = call;
  console.log(`Webhook received Updated Zone: ${zone},Condition: ${condition}, Confirmation: ${confirmation}`);
  
  if (zone === call && condition === call && confirmation === call) {
    wsConnections.forEach((ws) => placeTrade(ws, { symbol: 'frxXAUUSD', call, stake: 10, martingaleStep: 0, maxMartingaleSteps: 1 }));
    condition = confirmation = null;
    console.log(`Conditions met, entering Trade.`);
    console.log(`Updated Zone: ${zone},Condition: ${condition}, Confirmation: ${confirmation}`);
    
  }
};

app.post('/webhook', (req, res) => {
  const { symbol, call, message } = req.body;
  if (!symbol || !call || !message) return res.status(400).send('Invalid webhook payload');
  processTradeSignal(message, call);
  res.send('Trade processed');
});

app.listen(3000, () => console.log('Webhook listener running on port 3000'));
createWebSocketConnections();
