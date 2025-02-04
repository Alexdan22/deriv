const mongoose = require('mongoose');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
require('dotenv').config();

const API_TOKENS = process.env.API_TOKENS.split(',');
const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';
const PING_INTERVAL = 30000;

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const ProfitSchema = new mongoose.Schema({
  accountId: String,
  initialBalance: Number,
  dailyProfit: Number,
  lastReset: Date,
});

const Profit = mongoose.model('Profit', ProfitSchema);
const app = express();
app.use(bodyParser.json());

let wsConnections = [];
let accountsProfit = [];

const sendToWebSocket = (ws, data) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
};

const hasReachedProfitLimit = async (accountId) => {
  const profitData = await Profit.findOne({ accountId });
  if (!profitData) return false;
  const { initialBalance, dailyProfit } = profitData;
  return dailyProfit >= 0.1 * initialBalance;
};

const updateProfits = async () => {
  const accounts = await Profit.find({});
  for (const account of accounts) {
    const profitIncrease = 0.1 * account.initialBalance; // 10% profit margin
    account.dailyProfit += profitIncrease;
    await account.save();
  }
};

const resetDailyProfits = async () => {
  await Profit.updateMany({}, { dailyProfit: 0, lastReset: new Date() });
};

app.get('/reset-profits', async (req, res) => {
  await resetDailyProfits();
  res.send('Daily profits have been reset.');
});

app.get('/set-profits', async (req, res) => {
  await updateProfits();
  res.send('Profits updated for all accounts.');
});

const placeTrade = async (ws, trade, accountId) => {
  if (await hasReachedProfitLimit(accountId)) {
    console.log(`Account ${accountId} has reached daily profit limit. Ignoring trade.`);
    return;
  }
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
};

const handleTradeResult = async (contract, accountId) => {
  accountsProfit.push({ accountId, profit: contract.profit });
};

const createWebSocketConnections = () => {
  wsConnections.forEach(ws => ws.close());
  wsConnections = API_TOKENS.map((apiToken) => {
    const ws = new WebSocket(WEBSOCKET_URL);
    
    ws.on('open', () => {
      console.log(`Connected to API for token: ${apiToken}`);
      sendToWebSocket(ws, { authorize: apiToken });
      setInterval(() => sendToWebSocket(ws, { ping: 1 }), PING_INTERVAL);
    });
    
    ws.on('message', async (data) => {
      const response = JSON.parse(data);
      if (response.msg_type === 'proposal_open_contract') {
        const accountId = response.proposal_open_contract.account_id;
        await handleTradeResult(response.proposal_open_contract, accountId);
      }
    });
    return ws;
  });
};

app.post('/webhook', async (req, res) => {
  const { symbol, call, message, accountId } = req.body;
  if (!symbol || !call || !message || !accountId) {
    return res.status(400).send('Invalid webhook payload');
  }
  
  const ws = wsConnections.find(ws => ws.readyState === WebSocket.OPEN);
  if (ws) await placeTrade(ws, { symbol, call, stake: 10 }, accountId);
  res.send('Trade processed');
});

app.listen(3000, () => console.log('Webhook listener running on port 3000'));
createWebSocketConnections();
