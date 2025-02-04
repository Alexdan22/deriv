const mongoose = require('mongoose');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const axios = require('axios');
require('dotenv').config();

const API_TOKENS = process.env.API_TOKENS.split(',');
const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';
const PING_INTERVAL = 30000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Connect to MongoDB

mongoose.set('strictQuery', false);
mongoose.connect("mongodb://localhost:27017/testDerivDB");
// mongoose.connect("mongodb+srv://alex-dan:Admin-12345@cluster0.wirm8.mongodb.net/captchaHub");

const ProfitSchema = new mongoose.Schema({
  email: String,
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

const sendTelegramMessage = async (message) => {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
    });
  } catch (error) {
    console.error('Error sending Telegram message:', error);
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
  let message = 'Profit updates:\n';
  for (const account of accounts) {
    const profitIncrease = 0.1 * account.initialBalance; // 10% profit margin
    account.dailyProfit += profitIncrease;
    await account.save();
    message += `Account ${account.accountId}: Profit updated to ${account.dailyProfit}\n`;
  }
  sendTelegramMessage(message);
};

const resetDailyProfits = async () => {
  await Profit.updateMany({}, { dailyProfit: 0, lastReset: new Date() });
  sendTelegramMessage('Daily profits have been reset for all accounts.');
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
      console.log(response);

      if(response.msg_type === 'authorize'){
        const {email, balance} = response.authorize;
        const accounts = await Profit.find({});
        accounts.forEach(async(account)=>{
          if(account.email !== email){
            const newAccount = new Profit({
              email: email,
              accountId: 'nill',
              initialBalance: balance,
              dailyProfit: 0,
              lastReset: 0,
            });
            newAccount.save();
          }
        })
      }
      
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
