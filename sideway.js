const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const axios = require('axios');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { DateTime } = require('luxon');
const ti = require('technicalindicators');
const { Api } = require('./models/Api.js');
const { checkBreakoutSignal, checkTradeSignal } = require('./models/split_strategy.js');
// const { calculateIndicators, calculateExactRSI } = require('./models/indicators.js');
require('dotenv').config();




const app = express();
app.use(bodyParser.json());


// <------------ Database connection variables and utilities  - Start  ------------>

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


const Threshold = new mongoose.model('Threshold', profitSchema);


// --- UTILITIES ---
function debounce(func, delay) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func(...args), delay);
  };
}



// <------------ Database connection variables and utilities  - End  ------------>



// <------------ Server variables and utilities  - Start  ------------>


const accountTrades = new Map(); // Store trades for each account

const WEBSOCKET_URL = 'wss://ws.derivws.com/websockets/v3?app_id=67402';
const PING_INTERVAL = 30000;
let marketPrices = [];
let latestBollingerBands = []; //Array to store the latest Bollinger band values
// State variables for BUY and SELL condition
const stochasticState = {
  condition: 0,
  hasDroppedBelow65: false,
  hasCrossedAbove80: false,
  hasCrossedBelow20: false,
  hasRisenAbove35: false
};
const breakoutSignal = {
  holdforSell: false,
  holdforBuy: false
}
let wsMap = new Map(); // Store WebSocket connections
let tradeInProgress = false; // Flag to prevent multiple trades
let api_tokens = [];

async function getAllApiTokens() {
  try {
    
    const dbTokens = await Api.find({ readyForTrade: true }, "apiToken"); 
    
    const dbTokenArray = dbTokens.map((doc) => doc.apiToken); 

    return [...api_tokens, ...dbTokenArray]; // Merge .env tokens and DB tokens
    
  } catch (error) {
    console.error("Error fetching API tokens from DB:", error);
    return [];
  }
}

// <------------ Server variables and utilities  - End  ------------>


const sendToWebSocket = (ws, data) => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
};


//  ---------------------------------- Trade Execution ---------------------------------- 


// Function to aggregate OHLC data from tick data
function aggregateOHLC10Sec(prices) {
    const ohlcData10Sec = [];
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

            ohlcData10Sec.push({
                timestamp: parseInt(timestamp),
                open,
                high,
                low,
                close
            });
        }
    }

    return ohlcData10Sec;
}

function aggregateOHLC60Sec(prices) {
  const ohlcData10Sec = [];
  const groupedByTenSeconds = {};

  // Group prices by 60-second intervals
  prices.forEach(price => {
      const tenSecondTimestamp = Math.floor(price.timestamp / 60) * 60; // Round to the nearest 60 seconds
      if (!groupedByTenSeconds[tenSecondTimestamp]) {
          groupedByTenSeconds[tenSecondTimestamp] = [];
      }
      groupedByTenSeconds[tenSecondTimestamp].push(price.price);
  });

  // Calculate OHLC for each 60-second interval
  for (const [timestamp, pricesInTenSeconds] of Object.entries(groupedByTenSeconds)) {
      if (pricesInTenSeconds.length > 0) {
          const open = pricesInTenSeconds[0];
          const high = Math.max(...pricesInTenSeconds);
          const low = Math.min(...pricesInTenSeconds);
          const close = pricesInTenSeconds[pricesInTenSeconds.length - 1];

          ohlcData10Sec.push({
              timestamp: parseInt(timestamp),
              open,
              high,
              low,
              close
          });
      }
  }

  return ohlcData10Sec;
}

// Function to calculate Indicator values
async function calculateIndicators(prices) {

  const closePrices = prices.map(c => c.close);
  const highPrices = prices.map(c => c.high);
  const lowPrices = prices.map(c => c.low);
  if (!closePrices || closePrices.length === 0 || closePrices.some(isNaN)) {
    console.error('Invalid close prices for Bollinger Bands calculation');
    return;
  }


  
  // Stochastic Calculation
  const stochastic = ti.Stochastic.calculate({
      high: highPrices,
      low: lowPrices,
      close: closePrices,
      period: 84,
      signalPeriod: 84
  });

  // Bollinger Bands Calculation
  const bollingerBands = ti.BollingerBands.calculate({
      values: closePrices,
      period: 120,
      stdDev: 2
  });

  // EMA Calculations
  const ema9 = ti.EMA.calculate({ values: closePrices, period: 54 });
  const ema14 = ti.EMA.calculate({ values: closePrices, period: 84 });
  const ema21 = ti.EMA.calculate({ values: closePrices, period: 126 });

  const lastBollingerBand = bollingerBands[bollingerBands.length - 1];
  latestBollingerBands.push(lastBollingerBand);
  
  return {
      stochastic,
      ema9,
      ema14,
      ema21
  };
}

function calculateExactRSI(source, rsiLength = 14) {
  const rsi = [];
  const up = [];
  const down = [];
  
  // 1. Calculate price changes (like ta.change())
  const change = [];
  for (let i = 1; i < source.length; i++) {
    change[i] = source[i] - source[i - 1];
  }

  // 2. Separate gains and losses (like math.max/min)
  const gains = change.map(c => Math.max(c, 0));
  const losses = change.map(c => -Math.min(c, 0));

  // 3. Wilder's RMA (ta.rma) for gains/losses
  function wilderSmooth(data, length) {
    const smooth = [];
    let sum = 0;
    
    // First value = SMA
    for (let i = 0; i < length; i++) {
      sum += data[i] || 0; // Handle undefined (change[0])
    }
    smooth[length - 1] = sum / length;
    
    // Subsequent values = RMA
    for (let i = length; i < data.length; i++) {
      smooth[i] = (data[i] + (length - 1) * smooth[i - 1]) / length;
    }
    return smooth;
  }

  up.push(...wilderSmooth(gains, rsiLength));
  down.push(...wilderSmooth(losses, rsiLength));

  // 4. Calculate RSI (with edge cases)
  for (let i = rsiLength; i < source.length; i++) {
    if (down[i] === 0) {
      rsi[i] = 100; // Avoid division by zero
    } else if (up[i] === 0) {
      rsi[i] = 0;    // All losses
    } else {
      const rs = up[i] / down[i];
      rsi[i] = 100 - (100 / (1 + rs));
    }
  }

  // Pad beginning with NaN (like TradingView)
  return Array(rsiLength).fill(NaN).concat(rsi.slice(rsiLength));
}

// Function to process market data
const processMarketData = async () => {
  const now = DateTime.now().toSeconds(); // Current time in seconds
  const thirtySixMinutesAgo = now - (30 * 60); // 30 minutes ago in seconds

  // Filter marketPrices to only include prices from the last 30 minutes
  const recentPrices = marketPrices.filter(price => price.timestamp >= thirtySixMinutesAgo);

  // Aggregate tick data into 1-minute OHLC candles
  const ohlcData10Sec = aggregateOHLC10Sec(recentPrices);
  const ohlcData60Sec = aggregateOHLC60Sec(recentPrices);
  if (ohlcData10Sec.length < 180) return; // Ensure enough data for calculations
 

  // ✅ Fetch indicator values from the module
  const conditions = await calculateIndicators(ohlcData10Sec);
  const { stochastic, ema9, ema14, ema21} = conditions;
  
  const closePrices = ohlcData10Sec.map(c => c.close);
  const closePrices60Sec = ohlcData60Sec.map(c => c.close);
  const rsi = calculateExactRSI(closePrices60Sec);


  // ✅ Check trade signal using the calculated values
  const call = checkTradeSignal(stochastic, rsi);
  const breakout = checkBreakoutSignal(stochastic, rsi);

  if (call !== "HOLD") {
    // Reset state variables after placing a trade
    console.log(call);
    stochasticState.hasDroppedBelow65 = false;
    stochasticState.hasRisenAbove35 = false;
    stochasticState.hasCrossedAbove80 = false;
    stochasticState.hasCrossedBelow20 = false;

    const allTokens = await getAllApiTokens();
    allTokens.forEach(accountId => {
      const ws = wsMap.get(accountId);
      if (ws?.readyState === WebSocket.OPEN) {
        placeTrade(ws, accountId, { symbol: `frxXAUUSD`, call });
      } else {
        console.error(`[${accountId}] ❌ WebSocket not open, cannot place trade.`);
      }
    });
  }
};


// Function to place trade on WebSocket
const placeTrade = async (ws, accountId, trade) => {
  const timeZone = 'Asia/Kolkata';
  const currentTimeInTimeZone = DateTime.now().setZone(timeZone);

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
  const multiplier = 1;
  if (!trade) return;
  if (contract.profit < 0) {
    console.log(`[${accountId}] Trade lost, Updating stake`);
    // 1, 2.7, 7.2, 19.2, || 51.2, 136.50, 364
    if(trade.stake == 1*multiplier){
      user.pnl = user.pnl + (contract.profit || 0);
      user.stake = 2.7*multiplier;
      user.save();
    }else if( trade.stake == 2.7*multiplier){
      user.pnl = user.pnl + (contract.profit || 0);
      user.stake = 7.2*multiplier;
      user.save();
    }else if (trade.stake == 7.2*multiplier){
      user.pnl = user.pnl + (contract.profit || 0);
      user.stake = 19.2*multiplier;
      user.save();
    }else if (trade.stake == 19.2*multiplier){
      console.log(`[${accountId}] All Trade lost, Resetting stake`);
      user.pnl = user.pnl + (contract.profit || 0);
      user.stake = 1*multiplier;
      user.save();
    }else{
      console.log(`[${accountId}] All Trade lost, Resetting stake`);
      user.pnl = user.pnl + (contract.profit || 0);
      user.stake = 1*multiplier;
      user.save();
    }
  }else{
    console.log(`[${accountId}] Profit: ${contract.profit}`);
    
    if((user.balance +(user.stake +(contract.profit || 0))) > user.dynamicBalance){
      //New highest balance found, Adding up to balance
      const newBalance = user.balance + (user.stake +(contract.profit || 0));
      user.pnl = user.pnl + (contract.profit || 0);
      user.stake = 1*multiplier;
      user.balance = newBalance
      user.dynamicBalance = newBalance
      user.save();
    }else{
      //New highest balance not found, deducting from balance
      const newBalance = user.balance + (user.stake +(contract.profit || 0));
      user.pnl = user.pnl + (contract.profit || 0);
      user.stake = 1*multiplier;
      user.balance = newBalance
      user.save();
    }
  }
  tradesForAccount.delete(tradeId);

};

// Function to set Profit Threshold for every users
const setProfit = async (ws, response) => {
  
  const timeZone = 'Asia/Kolkata';
  const currentTimeInTimeZone = DateTime.now().setZone(timeZone);
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
    if(balance > 38){
      // Define stake levels
    const stakeLevels = [50, 100, 200, 300, 400, 500, 600, 700, 800];
    
    // Determine appropriate stake based on balance
    const stake = stakeLevels.find((s) => balance >= s && balance < s + 100) || 800;

    
    const today = new Threshold({
      email,
      name: fullname,
      balance,
      dynamicBalance: balance, // Dynamic balance for stoploss calculation
      stake: 1, 
      uniqueDate,
      apiToken,
      date: `${date}-${month}-${year}`,
      pnl: 0,
      tradePlan: stake,
      profitThreshold: stake * 0.15, // 15% of Trade plan
      stopLoss: 1000, // 10% of Trade plan
      trades: [],
    });
  
    await today.save();
    }
  }
  
};

const createWebSocketConnections = async () => {
  console.log("🔁 Checking for WebSocket updates...");

  const latestTokens = await getAllApiTokens(); // tokens in DB
  const latestTokenSet = new Set(latestTokens);
  const existingTokenSet = new Set(wsMap.keys());

  // --- 1. Add NEW tokens ---
  latestTokens.forEach(apiToken => {
    if (!wsMap.has(apiToken)) {
      console.log(`➕ New token detected, opening socket: ${apiToken}`);
      const ws = connectWebSocket(apiToken);
      wsMap.set(apiToken, ws);
    }
  });

  // --- 2. Remove OLD tokens that are no longer in DB ---
  wsMap.forEach((ws, token) => {
    if (!latestTokenSet.has(token)) {
      console.log(`❌ Token removed or disabled, closing socket: ${token}`);
      try {
        ws.close();
      } catch (err) {
        console.error(`Error closing WebSocket for ${token}:`, err);
      }
      wsMap.delete(token);
    }
  });

  console.log("✅ WebSocket connections synced with DB.");
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
                  
                  const now = DateTime.now().toSeconds(); // Current time in seconds
                  const thirtySixMinutesAgo = now - (30 * 60); // 30 minutes ago in seconds

                  if (response.tick && response.tick.quote !== undefined) {
                    // Extract the new tick data
                    const newTick = {
                      price: response.tick.quote,
                      timestamp: response.tick.epoch,
                    };

                    // Check if a tick with the same timestamp already exists
                    const isDuplicate = marketPrices.some(tick => tick.timestamp === newTick.timestamp);

                    if (!isDuplicate) {
                      // Append the new tick to the marketPrices array
                      marketPrices.push(newTick);
                      
                    // Filter out old data
                    marketPrices = marketPrices.filter(price => price.timestamp >= thirtySixMinutesAgo);
                    }
                } else {
                    console.warn("No tick or quote in message:", response);

                }
                


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

// --- DEBOUNCED VERSION ---
const debouncedReconnect = debounce(createWebSocketConnections, 3000);

// --- WATCH FOR DB CHANGES ---
function watchApiChanges() {
  const changeStream = Api.watch();

  changeStream.on("change", (change) => {
    console.log("📡 DB change detected:", change.operationType);
    if (["insert", "update", "replace", "delete"].includes(change.operationType)) {
      debouncedReconnect();
    }
  });

  changeStream.on("error", (err) => {
    console.error("❌ Change stream error:", err);
  });

  changeStream.on("close", () => {
    console.warn("⚠️ Change stream closed.");
  });
}

const now = new Date();
const currentSeconds = now.getSeconds();
const delay = (10 - (currentSeconds % 10)) * 1000; // Delay in milliseconds



function startAtNextMinute() {
  const now = new Date();
  const secondsUntilNextMinute = 60 - now.getSeconds();
  const delay = secondsUntilNextMinute * 1000; // Convert to milliseconds

  console.log(`Starting in ${secondsUntilNextMinute} seconds...`);

  setTimeout(() => {
    // --- CONNECT TO DB & START BOT ---
    mongoose.connect(process.env.MONGO_URI)
    .then(() => {
      console.log("✅ Connected to MongoDB");
      createWebSocketConnections();
      watchApiChanges();
    })
    .catch((err) => {
      console.error("❌ MongoDB connection error:", err);
    });
  

    setInterval(processMarketData, 10000); // Run every 10 second after that
  }, delay);
}






app.listen(3000, () => {
    console.log('Server running on port 3000');
    startAtNextMinute();
  });
  