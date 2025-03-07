const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const axios = require('axios');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { DateTime } = require('luxon');
require('dotenv').config();

const API_TOKENS = process.env.API_TOKENS ? process.env.API_TOKENS.split(',') : [];
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_CHAT_ID = process.env.CHANNEL_CHAT_ID;

const app = express();
app.use(bodyParser.json());

mongoose.set('strictQuery', false);
// mongoose.connect("mongodb://localhost:27017/mysteryDB");
mongoose.connect("mongodb+srv://alex-dan:Admin-12345@cluster0.wirm8.mongodb.net/mysteryDB");

const profitSchema = new mongoose.Schema({
  email: String,
  name: String,
  apiToken: String,
  dynamicBalance: Number,
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
  tradePlan: Number,
  stopLoss: Number,
  date: String,
  uniqueDate: String
});
const variableSchema = new mongoose.Schema({
  variables:{
    zone: String,
    condition: String
  },
  symbol: String
});
const apiTokenSchema = new mongoose.Schema({
  apiToken: String,
  email: String,
  fullname: String,
  scope: [String],
  user_id: Number,
  readyForTrade: Boolean,
});

const Api = new mongoose.model("Api", apiTokenSchema);

const Threshold = new mongoose.model('Threshold', profitSchema);

const Variable = new mongoose.model('Variable', variableSchema);

const timeZone = 'Asia/Kolkata';
const currentTimeInTimeZone = DateTime.now().setZone(timeZone);

async function getAllApiTokens() {
  try {
    
    const dbTokens = await Api.find({ readyForTrade: true }, "apiToken"); 
    
    const dbTokenArray = dbTokens.map((doc) => doc.apiToken); 

    return [...API_TOKENS, ...dbTokenArray]; // Merge .env tokens and DB tokens
  } catch (error) {
    console.error("Error fetching API tokens from DB:", error);
    return API_TOKENS;
  }
}

(async () => {
  const allTokens = await getAllApiTokens();
  console.log("✅ Final API Tokens:", allTokens);
})();

const accountTrades = new Map();
const tradeConditions = new Map();

const WEBSOCKET_URL = 'wss://ws.derivws.com/websockets/v3?app_id=67402';
const PING_INTERVAL = 30000;
let wsMap = new Map(); // Store WebSocket connections


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
    const stopLoss = user.stake * user.stopLoss;
    const dynamicStopLoss = user.dynamicBalance - stopLoss;
    const stopLossCondition = user.dynamicBalance - dynamicStopLoss;
    console.log(`[${accountId}] Balance: ${user.balance}, Stop Loss Condition: ${dynamicStopLoss}`);

    if(user.profitThreshold > user.pnl){
      //Placing Trade
          if (!accountTrades.has(accountId)) {
            accountTrades.set(accountId, new Map());
          }
          const tradesForAccount = accountTrades.get(accountId);
          tradesForAccount.set(tradeId, {
            symbol: trade.symbol,
            call: trade.call,
            stake: user.stake,
            martingaleStep: trade.martingaleStep || 0,
            maxMartingaleSteps: 1,
            contract_id: null,
            parentTradeId: trade.parentTradeId || null
          });
        console.log(`[${accountId}] Email: ${user.email} Placing trade for ${trade.call} on ${trade.symbol} with stake ${user.stake}`);
        
      if(user.balance > dynamicStopLoss){
        if (ws.readyState === WebSocket.OPEN) {
          sendToWebSocket(ws, {
            buy: "1",
            price: user.stake,
            parameters: {
              amount: user.stake,
              basis: "stake",
              contract_type: trade.call === "call" ? "CALL" : "PUT",
              currency: "USD",
              duration: trade.symbol === "frxXAUUSD" ? 5 : 15, // ✅ Dynamic duration
              duration_unit: "m",
              symbol: trade.symbol,
            },
            passthrough: { custom_trade_id: customTradeId },
          });
          user.balance = user.balance - user.stake;
          user.save();
          
        } else {
          console.error(`[${accountId}] WebSocket is not open. Cannot place trade.`);
        }
      }else{
        //Stop loss reached, skipping trades
        console.log(`[${accountId}] Stop loss reached for the day, skipping trade`);
      }
        
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



  
  const tradesForAccount = accountTrades.get(accountId);
  if (!tradesForAccount) return;

  const trade = tradesForAccount.get(tradeId);
  if (!trade) return;
  tradesForAccount.delete(tradeId);
  if (contract.profit < 0) {
    user.pnl = user.pnl + (contract.profit || 0);
    user.save();
  }else{
    console.log(`[${accountId}] Profit: ${contract.profit}`);
    
    if((user.balance +(user.stake +(contract.profit || 0))) > user.dynamicBalance){
      //New highest balance found, Adding up to balance
      const newBalance = user.balance + (user.stake +(contract.profit || 0));
      user.pnl = user.pnl + (contract.profit || 0);
      user.balance = newBalance
      user.dynamicBalance = newBalance
      user.save();
    }else{
      //New highest balance not found, deducting from balance
      const newBalance = user.balance + (user.stake +(contract.profit || 0));
      user.pnl = user.pnl + (contract.profit || 0);
      user.balance = newBalance
      user.save();
    }
  }

};

const setProfit = async (ws, response) => {
  let year = currentTimeInTimeZone.year;
  let month = currentTimeInTimeZone.month;
  let date = currentTimeInTimeZone.day;

  const apiToken = ws.accountId;
  if (!response || !response.authorize) {
    console.error(`[${apiToken}]❌ Authorization failed. Response:`, response);
    return;
  }

  const { email, balance, fullname } = response.authorize;
  console.log(`[${apiToken}]✅ Authorized email:`, email);
  
  const uniqueDate = `${date}-${month}-${year}_${apiToken}`;
  const foundUser = await Threshold.findOne({ uniqueDate });
  
  if (!foundUser) {
    if(balance > 49){
      // Define stake levels
    const stakeLevels = [50, 100, 200, 300, 400, 500, 600, 700, 800];
    
    // Determine appropriate stake based on balance
    const stake = stakeLevels.find((s) => balance >= s && balance < s + 100) || 800;

    
    const today = new Threshold({
      email,
      name: fullname,
      balance,
      dynamicBalance: balance, // Dynamic balance for stoploss calculation
      stake: stake * 0.025, // 2.5% of Trade plan
      uniqueDate,
      apiToken,
      date: `${date}-${month}-${year}`,
      pnl: 0,
      tradePlan: stake,
      profitThreshold: stake * 0.15, // 15% of Trade plan
      stopLoss: 4, // 10% of Trade plan
      trades: [],
    });
  
    await today.save();
    }
  }
  
};

const retrieveVariable = async () => {
  try {
    const variables = await Variable.find({}); // Retrieve all saved variables

    if (variables.length > 0) {
      variables.forEach(variable => {
        const { symbol, variables: { zone: savedZone, condition: savedCondition } } = variable;

        if (!tradeConditions.has(symbol)) {
          tradeConditions.set(symbol, new Map());

          tradeConditions.set(symbol, {
            zone: savedZone,
            label: null,
            confirmation: null,
            condition: savedCondition
          });
        }

      });

      console.log("✅ Variables restored from DB.");
    } else {
      console.log("⚠️ No saved variables found. Initializing with default values.");

      const newVariable1 = new Variable({
        symbol: "XAUUSD",
        variables: {
          zone: "null",
          condition: "null"
        }
      });
      await newVariable1.save();
      const newVariable2 = new Variable({
        symbol: "EURUSD",
        variables: {
          zone: "null",
          condition: "null"
        }
      });
      await newVariable2.save();
    }
  } catch (error) {
    console.error("❌ Error retrieving variables:", error);
  }
};

const createWebSocketConnections = async () => {
  // Close existing WebSockets on restart
  wsMap.forEach(ws => ws?.close());
  wsMap.clear(); // Clear all WebSockets before re-adding

  const allTokens = await getAllApiTokens();
  console.log("✅ Final API Tokens:", allTokens);

  allTokens.forEach(apiToken => {
    if (!wsMap.has(apiToken)) {
      wsMap.set(apiToken, connectWebSocket(apiToken)); // Store WebSocket
    }
  });

  await retrieveVariable();
};

const connectWebSocket = (apiToken) => {
  const ws = new WebSocket(WEBSOCKET_URL);
  ws.accountId = apiToken;

  let pingInterval;

  ws.on('open', () => {
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
      }
    } catch (error) {
      console.error(`[${apiToken}] Message processing failed:`, error);
    }
  });

  ws.on('close', () => {
    console.log(`[${apiToken}] Connection closed, attempting reconnection...`);

    setTimeout(() => {
      const existingWs = wsMap.get(apiToken);

      // Only reconnect if the current WebSocket is actually closed
      if (existingWs === ws && existingWs.readyState === WebSocket.CLOSED) {
        console.log(`[${apiToken}] Reconnecting WebSocket...`);
        wsMap.set(apiToken, connectWebSocket(apiToken));
      }
    }, 10000);
  });

  ws.on('error', (error) => console.error(`[${apiToken}] WebSocket error:`, error));

  return ws;
};

const processTradeSignal = async(symbol, message, call) => {

  if (!tradeConditions.has(symbol)) {
    tradeConditions.set(symbol, {
      zone: null,
      label: null,
      confirmation: null,
      condition: null
    });
  }

  const assetConditions = tradeConditions.get(symbol);

  // Update the asset-wide condition
  switch (message) {
    case 'ZONE': 
      assetConditions.zone = call;
      break;
    case 'LABEL': 
      assetConditions.label = call;
      break;
    case 'CONFIRMATION': 
      assetConditions.confirmation = call;
      break;
    case 'CONDITION': 
      assetConditions.condition = call;
      break;
  }

  const variables = await Variable.find({}); // Retrieve all saved variables

  if (variables.length > 0) {
    for (const variable of variables) {
      if (variable.symbol === symbol) {
        switch (message) {
          case 'ZONE': 
            variable.variables.zone = assetConditions.zone;
            break; 
          case 'CONDITION': 
            variable.variables.condition = assetConditions.condition;
            break;
        }

        await variable.save(); // Save each updated document
      }
    }
  }


  // let shouldSendAlert = false;

  // if (message === 'LABEL') {
  //   if (
  //     assetConditions.zone === call &&
  //     assetConditions.condition === call &&
  //     assetConditions.label === call
  //   ) {
  //     shouldSendAlert = true;
  //   }
  // } else if (message === 'CONFIRMATION') {
  //   if (
  //     assetConditions.zone === call &&
  //     assetConditions.condition === call &&
  //     assetConditions.confirmation === call
  //   ) {
  //     shouldSendAlert = true;
  //   }
  // }

  // if (shouldSendAlert) {
  //   sendTelegramAlert(symbol, call);
  //   assetConditions.alerted = true; // Mark as alerted to avoid duplicate messages
  // }

  // Process trades for all accounts
  
  
  API_TOKENS.forEach(accountId => {

    if (message === 'LABEL') {
      if (
        assetConditions.zone === call &&
        assetConditions.label === call
      ) {
        const ws = wsMap.get(accountId); // ✅ Use Map instead of array
        if (ws) {
          placeTrade(ws, accountId, { symbol: `frx${symbol}`, call });
        } else {
          console.error(`[${accountId}] ❌ WebSocket not found, cannot place trade.`);
        }
      }
    } else if (message === 'CONFIRMATION') {
      if (
        assetConditions.zone === call &&
        assetConditions.confirmation === call
      ) {
        const ws = wsMap.get(accountId); // ✅ Use Map instead of array
        if (ws) {
          placeTrade(ws, accountId, { symbol: `frx${symbol}`, call });
        } else {
          console.error(`[${accountId}] ❌ WebSocket not found, cannot place trade.`);
        }
      }
    }

  });
};




app.post('/webhook', async (req, res) => {
  const { symbol, call, message } = req.body;
  
  if (!symbol || !call || !message) {
    return res.status(400).send('Invalid payload');
  }

  if(message === 'MANUAL'){
    API_TOKENS.forEach(accountId => {
      const ws = wsMap.get(accountId); // ✅ Use Map instead of array
      if (ws) {
        placeTrade(ws, accountId, { symbol: `frx${symbol}`, call });
      } else {
        console.error(`[${accountId}] ❌ WebSocket not found, cannot place trade.`);
      }
    });
  }else if(message === 'ZONE' || message === 'LABEL' || message === 'CONFIRMATION'){
    processTradeSignal(symbol, message, call);
  }
  
    
  res.send('Signal processed');
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
  createWebSocketConnections();
});
