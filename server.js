const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const axios = require('axios');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { DateTime } = require('luxon');
require('dotenv').config();

const API_TOKENS = process.env.API_TOKENS.split(',');
const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_CHAT_ID = process.env.CHANNEL_CHAT_ID;

const app = express();
app.use(bodyParser.json());

mongoose.set('strictQuery', false);
// mongoose.connect("mongodb://localhost:27017/derivTradeDB");
mongoose.connect("mongodb+srv://alex-dan:Admin-12345@cluster0.wirm8.mongodb.net/derivTradeDB");

const profitSchema = new mongoose.Schema({
  email: String,
  name: String,
  apiToken: String,
  balance: Number,
  stake: Number,
  profitThreshold: Number,
  pnl: Number,
  trades:[
    {
      call: String,
      entry_price: Number,
      exit_price: Number,
      status: String,
      profit: Number
    }
  ],
  date: String,
  uniqueDate: String
});

const Threshold = new mongoose.model('Threshold', profitSchema);

const timeZone = 'Asia/Kolkata';
const currentTimeInTimeZone = DateTime.now().setZone(timeZone);


const accountTrades = new Map();
const zone = new Map();
const label = new Map();
const confirmation = new Map();
const condition = new Map();

let zoneTele = null;
let confirmationTele = null;
let labelTele = null;
let conditionTele = null;

const PING_INTERVAL = 30000;
let wsConnections = [];

const sendToWebSocket = (ws, data) => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
};

const placeTrade = async (ws, accountId, trade) => {
  let year = currentTimeInTimeZone.year;
  let month = currentTimeInTimeZone.month;
  let date = currentTimeInTimeZone.day;

  const uniqueDate = `${date}-${month}-${year}_${ws.accountId}`;
  const tradeId = uuidv4();
  const customTradeId = `${accountId}_${tradeId}`;
  const user = await Threshold.findOne({uniqueDate});
  

  if(user){
    //Process trade further
    if(user.profitThreshold > user.pnl){
      //Placing Trade
        if (!accountTrades.has(accountId)) {
          accountTrades.set(accountId, new Map());
        }
        const tradesForAccount = accountTrades.get(accountId);
        tradesForAccount.set(tradeId, {
          symbol: "frxXAUUSD",
          call: trade.call,
          stake: user.stake,
          martingaleStep: trade.martingaleStep || 0,
          maxMartingaleSteps: 1,
          contract_id: null,
          parentTradeId: trade.parentTradeId || null
        });

        sendToWebSocket(ws, {
          buy: "1",
          price: user.stake,
          parameters: {
            amount: user.stake,
            basis: "stake",
            contract_type: trade.call === "call" ? "CALL" : "PUT",
            currency: "USD",
            duration: 6,
            duration_unit: "m",
            symbol: "frxXAUUSD",
          },
          passthrough: { 
            custom_trade_id: customTradeId 
          }
        });
    }else{
      //Profit threshold reached, skipping trades
      console.log(`[${accountId}] Profit threshold reached for the day, skipping trade`);
      
    }
  }else{
    //User not for, skipping trade
      console.log(`[${accountId}] Account not found, skipping trade`);
      
      
  }
};

const handleTradeResult = async (contract, accountId, tradeId) => {
  let year = currentTimeInTimeZone.year;
  let month = currentTimeInTimeZone.month;
  let date = currentTimeInTimeZone.day;

  const uniqueDate = `${date}-${month}-${year}_${accountId}`;
  const user = await Threshold.findOne({uniqueDate});

  const newValue = user.pnl + contract.profit;
  await Threshold.updateOne({uniqueDate}, {$set:{pnl:newValue}});


  
  const tradesForAccount = accountTrades.get(accountId);
  if (!tradesForAccount) return;

  const trade = tradesForAccount.get(tradeId);
  if (!trade) return;
  tradesForAccount.delete(tradeId);
  // if (contract.profit < 0) {
  //   if (trade.martingaleStep < trade.maxMartingaleSteps) {
  //     // const newStake = trade.stake * 2;
  //     const ws = wsConnections.find(conn => conn.accountId === accountId);
  //     if(condition.get(accountId) !== null){
  //       await placeTrade(ws, accountId, {
  //         symbol: trade.symbol,
  //         call: condition.get(accountId) === "call" ? "CALL" : "PUT",
  //         stake: trade.stake,
  //         martingaleStep: trade.martingaleStep + 1,
  //         parentTradeId: tradeId
  //       });
  //     }else{
  //       await placeTrade(ws, accountId, {
  //         symbol: trade.symbol,
  //         call: trade.call,
  //         stake: trade.stake,
  //         martingaleStep: trade.martingaleStep + 1,
  //         parentTradeId: tradeId
  //       });
  //     }
      

  //     console.log(`[${accountId}] Martingale step ${trade.martingaleStep + 1} for trade chain ${trade.parentTradeId || tradeId}`);
  //   } else {
  //     console.log(`[${accountId}] Max Martingale steps reached for trade chain ${trade.parentTradeId || tradeId}`);
  //     tradesForAccount.delete(tradeId);
  //   }
  // }else{
  //   console.log(`[${accountId}] Trade won, Returning to Idle state`);
    
  // }

};

const setProfit = async (ws, response) => {
  let year = currentTimeInTimeZone.year;
  let month = currentTimeInTimeZone.month;
  let date = currentTimeInTimeZone.day;

  const apiToken = ws.accountId;
  const {email, balance, fullname} = response.authorize;
  const uniqueDate = `${date}-${month}-${year}_${apiToken}`;
  const foundUser = await Threshold.findOne({uniqueDate});

  if(!foundUser){
    if(balance >59 && balance < 119){
      const today = new Threshold({
        email,
        name: fullname,
        balance,
        stake:4,
        uniqueDate,
        apiToken,
        date: `${date}-${month}-${year}`,
        pnl: 0,
        profitThreshold:6
  
      });
      today.save();

    }else if(balance >119 && balance < 179){
      const today = new Threshold({
        email,
        name: fullname,
        balance,
        stake:8,
        uniqueDate,
        apiToken,
        date: `${date}-${month}-${year}`,
        pnl: 0,
        profitThreshold:12
  
      });
      today.save();

    }else if(balance >179 && balance < 299){
      const today = new Threshold({
        email,
        name: fullname,
        balance,
        stake:12,
        uniqueDate,
        apiToken,
        date: `${date}-${month}-${year}`,
        pnl: 0,
        profitThreshold:18
  
      });
      today.save();

    }else if(balance > 299){
      const today = new Threshold({
        email,
        name: fullname,
        balance,
        stake:20,
        uniqueDate,
        apiToken,
        date: `${date}-${month}-${year}`,
        pnl: 0,
        profitThreshold:30
  
      });
      today.save();

    }
    
  }
}

const createWebSocketConnections = () => {
  wsConnections.forEach(ws => ws?.close());
  
  wsConnections = API_TOKENS.map(apiToken => {
    return connectWebSocket(apiToken);
  });
};

const connectWebSocket = (apiToken) => {
  const ws = new WebSocket(WEBSOCKET_URL);
  ws.accountId = apiToken;

  let pingInterval;

  ws.on('open', () => {
    console.log(`[${apiToken}] Connected`);
    sendToWebSocket(ws, { authorize: apiToken });

    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        sendToWebSocket(ws, { ping: 1 });
        sendToWebSocket(ws, { proposal_open_contract: 1, subscribe: 1 });
      }
    }, PING_INTERVAL);
  });

  ws.on("message", (data) => {
    try {
      const response = JSON.parse(data);
      if (!response.msg_type) return;

      switch (response.msg_type) {
        case "authorize":
          try {
            setProfit(ws, response);
          } catch (error) {
            console.error(`[${apiToken}] Authorization failed:`, error);
          }
          break;

        case "buy":
          if (!response.buy || !response.buy.contract_id) {
            console.warn(`[${apiToken}] Invalid buy response:`, response);
            return;
          }
          const customTradeId = response.passthrough?.custom_trade_id;
          if (customTradeId) {
            const [accountId, tradeId] = customTradeId.split("_");
            const tradesForAccount = accountTrades.get(accountId);
            if (tradesForAccount?.has(tradeId)) {
              tradesForAccount.get(tradeId).contract_id = response.buy.contract_id;
            }
          }
          break;

        case "proposal_open_contract":
          const contract = response.proposal_open_contract;
          if (!contract?.contract_id) return;

          if (contract.status !== "open") {
            for (const [accountId, trades] of accountTrades) {
              for (const [tradeId, trade] of trades) {
                if (trade.contract_id === contract.contract_id) {
                  handleTradeResult(contract, accountId, tradeId);
                  return;
                }
              }
            }
          }
          break;

        default:
          console.log(`[${apiToken}] Unknown message type:`, response);
      }
    } catch (error) {
      console.error(`[${apiToken}] Message processing failed:`, error);
    }
  });

  ws.on('close', () => {
    console.log(`[${apiToken}] Connection closed, cleaning up...`);
    wsConnections = wsConnections.filter(conn => conn.accountId !== apiToken);
    setTimeout(() => connectWebSocket(apiToken), 10000);
  });

  ws.on('error', (error) => console.error(`[${apiToken}] WebSocket error:`, error));

  return ws;
};

const processTradeSignal = (message, call) => {
  API_TOKENS.forEach(accountId => {
    if (!zone.has(accountId)) zone.set(accountId, null);
    if (!label.has(accountId)) label.set(accountId, null);
    if (!confirmation.has(accountId)) confirmation.set(accountId, null);
    if (!condition.has(accountId)) condition.set(accountId, null);

    switch(message) {
      case 'ZONE': 
        zone.set(accountId, call);
        break;
      case 'LABEL': 
        label.set(accountId, call);
        break;  
      case 'CONFIRMATION': 
        confirmation.set(accountId, call); 
        break;  
      case 'CONDITION': 
        condition.set(accountId, call); 
        break;
    }
    
    if (
      zone.get(accountId) === call &&
      label.get(accountId) === call &&
      confirmation.get(accountId) === call &&
      condition.get(accountId) === call
    ) {
      const ws = wsConnections.find(conn => conn.accountId === accountId);
      if (ws) {
        placeTrade(ws, accountId, {
          symbol: 'frxXAUUSD',
          call
        });
      }
    }
  });
};

const sendTelegramMessage = async (message, call) => {
  
  switch(message) {
    case 'ZONE': 
      zoneTele = call;
      break;
    case 'LABEL': 
      labelTele = call;
      break;  
    case 'CONFIRMATION': 
      confirmationTele = call; 
      break;  
    case 'CONDITION': 
      conditionTele = call; 
      break;
  }
  
  


  
  try {
    if (
      zoneTele === call &&
      labelTele === call &&
      confirmationTele === call &&
      conditionTele === call
    ) {
      const messageType = call === 'call' ? 'BUY 🟢🟢🟢' :  'SELL 🔴🔴🔴';
      const alertMessage = 
      `Hello Traders
      
XAUUSD (Gold  Spot)
      
${messageType}`

      // Send the message to Telegram
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: CHANNEL_CHAT_ID,
        text: alertMessage,
      });
    }
    

  } catch (error) {

          console.error('Error fetching chat ID:' + error);
  }
}

app.post('/webhook', async (req, res) => {
  const { symbol, call, message } = req.body;
  if (!symbol || !call || !message) {
    return res.status(400).send('Invalid payload');
  }
  
  sendTelegramMessage(message, call)
  processTradeSignal(message, call);
    
  res.send('Signal processed');
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
  createWebSocketConnections();
});
