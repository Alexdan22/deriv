const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const axios = require('axios');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { DateTime } = require('luxon');
require('dotenv').config();

const API_TOKENS = process.env.API_TOKENS ? process.env.API_TOKENS.split(',') : [];

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

const accountTrades = new Map(); // Store trades for each account

const WEBSOCKET_URL = 'wss://ws.derivws.com/websockets/v3?app_id=67402';
const PING_INTERVAL = 30000;
let marketPrices = [];
let latestRSIValues = []; // Array to store the latest 6 RSI values
let isStochasticAbove80 = false; // Tracks if Stochastic has crossed above 80
let isStochasticBelow20 = false; // Tracks if Stochastic has crossed below 20
let isStochasticAbove20 = false; // Tracks if Stochastic has crossed above 60
let isStochasticBelow80 = false; // Tracks if Stochastic has crossed below 40
let wsMap = new Map(); // Store WebSocket connections
let tradeInProgress = false; // Flag to prevent multiple trades
const tradeConditions = new Map();


const sendToWebSocket = (ws, data) => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
};

// ---------------------------------- Trade Execution ----------------------------------


// Function to aggregate OHLC data from tick data
function aggregateOHLC(prices) {
    const ohlcData = [];
    const groupedByTenSeconds = {};

    // Group prices by 10-second intervals
    prices.forEach(price => {
        const tenSecondTimestamp = Math.floor(price.timestamp / 10) * 10; // Round to the nearest 10 seconds
        if (!groupedByTenSeconds[tenSecondTimestamp]) {
            groupedByTenSeconds[tenSecondTimestamp] = [];
        }
        groupedByTenSeconds[tenSecondTimestamp].push(price.price);
    });

    // Calculate OHLC for each 10-second interval
    for (const [timestamp, pricesInTenSeconds] of Object.entries(groupedByTenSeconds)) {
        if (pricesInTenSeconds.length > 0) {
            const open = pricesInTenSeconds[0];
            const high = Math.max(...pricesInTenSeconds);
            const low = Math.min(...pricesInTenSeconds);
            const close = pricesInTenSeconds[pricesInTenSeconds.length - 1];

            ohlcData.push({
                timestamp: parseInt(timestamp),
                open,
                high,
                low,
                close
            });
        }
    }

    return ohlcData;
}


// Modify the `calculateStochastic` and `calculateRSI` functions to work with the 14-minute window
function calculateStochastic(prices, period = 84, smoothing = 3) {
    if (prices.length < period) return 50; // Return neutral value if insufficient data

    let highestHigh = Math.max(...prices.slice(-period));
    let lowestLow = Math.min(...prices.slice(-period));
    let currentClose = prices[prices.length - 1];

    let percentK = ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;

    return percentK;
}

function calculateRSI(prices, period = 84) {
    if (prices.length < period) return 50; // Return neutral value if insufficient data

    let gains = 0, losses = 0;

    // Calculate gains and losses for the entire period
    for (let i = 1; i < prices.length; i++) {
        let change = prices[i] - prices[i - 1];
        if (change > 0) gains += change;
        else losses -= change;
    }

    // Calculate average gains and losses
    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Avoid division by zero
    if (avgLoss === 0) return 100;

    // Calculate RS and RSI
    let rs = avgGain / avgLoss;
    let rsi = 100 - (100 / (1 + rs));

    return rsi;
}

function calculateEMA(prices, period) {
  const smoothingFactor = 2 / (period + 1); // Smoothing factor for EMA
  let emaValues = [];

  // Calculate the initial SMA as the first EMA value
  let sma = prices.slice(0, period).reduce((sum, price) => sum + price, 0) / period;
  emaValues.push(sma);

  // Calculate EMA for the remaining prices
  for (let i = period; i < prices.length; i++) {
      const ema = (prices[i] * smoothingFactor) + (emaValues[i - period] * (1 - smoothingFactor));
      emaValues.push(ema);
  }

  return emaValues;
}

function checkTradeSignal(stochasticValues, latestRSIValues, ema9, ema14, ema21){
      // Ensure there are enough Stochastic values for calculation
      if (stochasticValues.length < 1) {
        console.log("Insufficient Stochastic values for calculation");
        return "HOLD";
    }

    let lastK = stochasticValues[stochasticValues.length - 1]; // Last Stochastic value

    console.log("Last Stochastic Value:", lastK);
    console.log("Latest RSI Values:", latestRSIValues);

    // Check if any of the latest RSI values are below 40 (for BUY) or above 60 (for SELL)
    const isRSIBuy = latestRSIValues.some(rsi => rsi > 50); // At least one RSI value below 45
    const isRSISell = latestRSIValues.some(rsi => rsi < 50); // At least one RSI value above 55
    let lastEma9 = ema9[ema9.length - 1]; // Latest EMA 9 value
    let lastEma14 = ema14[ema14.length - 1]; // Latest EMA 14 value
    let lastEma21 = ema21[ema21.length - 1]; // Latest EMA 21 value


    // Update first stage state variables based on Stochastic values
    if (lastK > 80) {
        isStochasticAbove80 = true; // Stochastic crossed above 80
        console.log("Stochastic crossed above 80");
    }
    if (lastK < 80) {
        isStochasticBelow80 = true; // Stochastic crossed below 80
        console.log("Stochastic crossed below 80");
    }
    // Update second stage state variables based on Stochastic values
    if (lastK < 20 && isStochasticAbove80) {
      isStochasticAbove20 = true; // Stochastic crossed above 20
      console.log("Stochastic crossed above 20");
    }
    if (lastK < 20 && isStochasticBelow20) {
        isStochasticBelow20 = true; // Stochastic crossed below 20
        console.log("Stochastic crossed below 20");
    }

    // Buy Signal: Stochastic crosses back above 20 after being below 20, and RSI condition is met
    if (isStochasticBelow80 && isStochasticAbove80 && lastK >= 80 && isRSIBuy && lastEma9 > lastEma14 && lastEma14 > lastEma21) {
        console.log("BUY Signal Triggered");
        isStochasticAbove20 = false;
        isStochasticBelow20 = false;
        isStochasticBelow80 = false;
        isStochasticAbove80 = false; // Reset the state
        return "BUY";
    }

    // Sell Signal: Stochastic crosses back below 80 after being above 80, and RSI condition is met
    if (isStochasticAbove80 && lastK <= 80 && isRSISell && lastEma9 < lastEma14 && lastEma14 < lastEma21) {
        console.log("SELL Signal Triggered");
        isStochasticAbove20 = false;
        isStochasticBelow20 = false;
        isStochasticBelow80 = false;
        isStochasticAbove80 = false; // Reset the state
        return "SELL";
    }

    // Default to HOLD
    console.log("HOLD Signal");
    return "HOLD";
}

// Function to place trade on WebSocket
const placeTrade = async (ws, accountId, trade) => {

  if (tradeInProgress) {
      console.log("Trade already in progress. Skipping new trade...");
      return;
   }
   
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
            tradeInProgress = true;
          sendToWebSocket(ws, {
            buy: "1",
            price: user.stake,
            parameters: {
              amount: user.stake,
              basis: "stake",
              contract_type: trade.call === "BUY" ? "CALL" : "PUT",
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

// Function to handle trade result
const handleTradeResult = async (contract, accountId, tradeId) => {
  let year = currentTimeInTimeZone.year;
  let month = currentTimeInTimeZone.month;
  let date = currentTimeInTimeZone.day;

  const uniqueDate = `${date}-${month}-${year}_${accountId}`;
  const user = await Threshold.findOne({uniqueDate});

  tradeInProgress = false;



  
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

// Function to set Profit Threshold for every users
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

const processMarketData = () => {
  const now = DateTime.now().toSeconds(); // Current time in seconds
  const fourteenMinutesAgo = now - (22 * 60); // 14 minutes ago in seconds

  // Filter marketPrices to only include prices from the last 14 minutes
  const recentPrices = marketPrices
      .filter(price => price.timestamp >= fourteenMinutesAgo);

  // Aggregate tick data into 1-minute OHLC candles
  const ohlcData = aggregateOHLC(recentPrices);

  if (ohlcData.length < 126){
    console.log("Insufficient data for calculations");
    console.log("OHLC Data Length:", ohlcData.length);
    
    return; // Ensure enough data for calculations
  } 

  // Extract closing prices for RSI and Stochastic calculations
  const closingPrices = ohlcData.map(candle => candle.close);

  // Calculate Stochastic values
  const stochasticValues = closingPrices.map((_, i) => calculateStochastic(closingPrices.slice(0, i + 1))).filter(v => v !== null);

  // Keep only the last 14 values (or any other desired length)
  if (stochasticValues.length > 14) {
      stochasticValues.shift(); // Remove the oldest value
  }

  // Calculate EMA values
  const ema9 = calculateEMA(closingPrices, 54); // EMA for 9 periods
  const ema14 = calculateEMA(closingPrices, 84); // EMA for 14 periods
  const ema21 = calculateEMA(closingPrices, 126); // EMA for 21 periods

  // Update the latest RSI values array
  latestRSIValues.push(calculateRSI(closingPrices));
  if (latestRSIValues.length > 6) {
      latestRSIValues.shift(); // Keep only the latest 6 values
  }

  console.log("EMA 9:", ema9[ema9.length - 1]); // Latest EMA 9 value
  console.log("EMA 14:", ema14[ema14.length - 1]); // Latest EMA 14 value
  console.log("EMA 21:", ema21[ema21.length - 1]); // Latest EMA 21 value

  const call = checkTradeSignal(stochasticValues, latestRSIValues, ema9, ema14, ema21);

  if (call !== "HOLD") {
      API_TOKENS.forEach(accountId => {
          const ws = wsMap.get(accountId); // ✅ Use Map instead of array
          if (ws.readyState === WebSocket.OPEN) {
              placeTrade(ws, accountId, { symbol: `frxXAUUSD`, call });
          } else {
              console.error(`[${accountId}] ❌ WebSocket not open, cannot place trade.`);
          }
      });
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
};

const connectWebSocket = (apiToken) => {
  const ws = new WebSocket(WEBSOCKET_URL);
  ws.accountId = apiToken;

  let pingInterval;

  ws.on('open', () => {
    sendToWebSocket(ws, { authorize: apiToken });
    sendToWebSocket(ws, { ticks: "frxXAUUSD" });

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
        
        case "tick":
            try {
                // Store the price and timestamp in the marketPrices array
                marketPrices.push({
                    price: response.tick.quote,
                    timestamp: response.tick.epoch // Unix epoch time in seconds
                });

                // Keep only the last 14 minutes of data
                const now = DateTime.now().toSeconds(); // Current time in seconds
                const fourteenMinutesAgo = now - (22 * 60); // 14 minutes ago in seconds

                // Filter out old data
                marketPrices = marketPrices.filter(price => price.timestamp >= fourteenMinutesAgo);

                // Debug log to check the number of prices in the last 14 minutes
            } catch (error) {
                console.error(`[${apiToken}] Tick failed:`, error);
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

app.post('/webhook', async (req, res) => {
  const { symbol, call, message } = req.body;
  
  if (!symbol || !call || !message) {
    return res.status(400).send('Invalid payload');
  }

  if (!tradeConditions.has(symbol)) {
    tradeConditions.set(symbol, {
      zone: call,
    });
  } 

  const assetConditions = tradeConditions.get(symbol);

  // Update the asset-wide condition
  switch (message) {
    case 'ZONE': 
      assetConditions.zone = call;
      break;
  }
  
    
  res.send('Signal processed');
});

const now = new Date();
const currentSeconds = now.getSeconds();
const delay = (10 - (currentSeconds % 10)) * 1000; // Delay in milliseconds

setTimeout(() => {
  // Start the interval after the delay
  setInterval(processMarketData, 10000); // Run every 10 seconds
}, delay);








app.listen(3000, () => {
    console.log('Server running on port 3000');
    createWebSocketConnections();
  });
  