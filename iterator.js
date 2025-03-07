const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const axios = require('axios');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { DateTime } = require('luxon');
const ti = require('technicalindicators');
require('dotenv').config();

const API_TOKENS = process.env.API_TOKENS ? process.env.API_TOKENS.split(',') : [];

const app = express();
app.use(bodyParser.json());

mongoose.set('strictQuery', false);
// mongoose.connect("mongodb://localhost:27017/mysteryDB");
mongoose.connect(process.env.MONGO_URI);

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
// State variables for BUY and SELL condition
const stochasticState = {
  hasCrossedAbove80: false,
  hasDroppedBelow70: false,
  hasCrossedBelow20: false,
  hasRisenAbove30: false
};
let wsMap = new Map(); // Store WebSocket connections
let tradeInProgress = false; // Flag to prevent multiple trades
const tradeConditions = new Map();
let trend = null; // Default market trend


const sendToWebSocket = (ws, data) => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
};


//  ---------------------------------- Trade Execution ---------------------------------- 


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

// Function to calculate Indicator values
async function calculateIndicators(prices) {
  const closePrices = prices.map(c => c.close);
  const highPrices = prices.map(c => c.high);
  const lowPrices = prices.map(c => c.low);

  // RSI Calculation
  const rsi = ti.RSI.calculate({ values: closePrices, period: 84 });
  
  // Stochastic Calculation
  const stochastic = ti.Stochastic.calculate({
      high: highPrices,
      low: lowPrices,
      close: closePrices,
      period: 84,
      signalPeriod: 3
  });

  // Bollinger Bands Calculation
  const bollingerBands = ti.BollingerBands.calculate({
      values: closePrices,
      period: 84,
      stdDev: 2
  });

  // EMA Calculations
  const ema9 = ti.EMA.calculate({ values: closePrices, period: 54 });
  const ema14 = ti.EMA.calculate({ values: closePrices, period: 84 });
  const ema21 = ti.EMA.calculate({ values: closePrices, period: 126 });

  return {
      rsi,
      stochastic,
      bollingerBands,
      ema9,
      ema14,
      ema21
  };
}

// Function to check trade signals based on indicators
function checkTradeSignal(stochastic, rsi, ema9, ema14, ema21, bollingerBands) {
  const now = DateTime.now(); // Current time in seconds
  if (!stochastic?.length || !rsi?.length || !ema9?.length || !ema14?.length || !ema21?.length || !bollingerBands?.length) {
    console.log("Insufficient indicator values for calculation");
    return "HOLD";
  }

  // Get latest indicator values
  const currentTime = DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss');
  const lastStochastic = stochastic[stochastic.length - 1]; 
  const lastK = lastStochastic.k;
  const lastRSI = rsi[rsi.length - 1];
  const lastEMA9 = ema9[ema9.length - 1];
  const lastEMA14 = ema14[ema14.length - 1];
  const lastEMA21 = ema21[ema21.length - 1];
  const lastBollingerBand = bollingerBands[bollingerBands.length - 1];

  const lastBollingerUpper = lastBollingerBand.upper;
  const lastBollingerLower = lastBollingerBand.lower;

  // Determine market trend
  const marketValue = lastBollingerUpper - lastBollingerLower;
  
  

  // **TRENDING MARKET STRATEGY**
  if (marketValue > 2) {
    if(trend !== "trending" || trend === null){
      trend = "trending";
      hasCrossedAbove80 = false;
      hasDroppedBelow70 = false;
      hasCrossedBelow20 = false;
      hasRisenAbove30 = false;
      console.log(`Market Value: ${marketValue}`);
      console.log("--------------------------------------------------------");
      console.log(`📈 Trending Market Strategy detected at ${currentTime}`);
      console.log("--------------------------------------------------------");
    }

    // ✅ Check BUY conditions
    if (lastK > 80 && !stochasticState.hasCrossedAbove80) {
      stochasticState.hasCrossedAbove80 = true;
      console.log(`✅ Stochastic crossed above 80 at ${currentTime}`);
    }

    if (stochasticState.hasCrossedAbove80 && lastK < 70 && !stochasticState.hasDroppedBelow70) {
      stochasticState.hasDroppedBelow70 = true;
      console.log(`✅ Stochastic dropped below 70 after crossing above at ${currentTime}`);
    }

    if (stochasticState.hasCrossedAbove80 && stochasticState.hasDroppedBelow70 && lastK > 80) {
      console.log(`📈 Stochastic rose back above 80 after dropping below at ${currentTime}`);

      // Reset state variables
      stochasticState.hasCrossedAbove80 = false;
      stochasticState.hasDroppedBelow70 = false;
      stochasticState.hasCrossedBelow20 = false;
      stochasticState.hasRisenAbove30 = false;

      // ✅ Confirm RSI & EMA conditions for BUY
      const isRSIBuy = lastRSI > 55;
      const isEMAUptrend = lastEMA9 > lastEMA14 && lastEMA14 > lastEMA21;

      if (isRSIBuy && isEMAUptrend) {
        console.log("Stochastic:", lastK);
        console.log("RSI:", lastRSI);
        console.log("Upper Bollinger Band:", lastBollingerUpper);
        console.log("Lower Bollinger Band:", lastBollingerLower);
        console.log("EMA9:", lastEMA9);
        console.log("EMA14:", lastEMA14);
        console.log("EMA21:", lastEMA21);
        console.log("---------------------------");
        console.log(`🚀 BUY Signal Triggered at ${currentTime}`);
        console.log("---------------------------");
        return "BUY";
      }
    }

    // ✅ Check SELL conditions
    if (lastK < 20 && !stochasticState.hasCrossedBelow20) {
      stochasticState.hasCrossedBelow20 = true;
      console.log(`✅ Stochastic crossed below 20 at ${currentTime}`);
    }

    if (stochasticState.hasCrossedBelow20 && lastK > 30 && !stochasticState.hasRisenAbove30) {
      stochasticState.hasRisenAbove30 = true;
      console.log(`✅ Stochastic rose above 30 after crossing below at ${currentTime}`);
    }

    if (stochasticState.hasCrossedBelow20 && stochasticState.hasRisenAbove30 && lastK < 20) {
      console.log(`📉 Stochastic dropped back below 20 after rising above at ${currentTime}`);

      // Reset state variables
      stochasticState.hasCrossedAbove80 = false;
      stochasticState.hasDroppedBelow70 = false;
      stochasticState.hasCrossedBelow20 = false;
      stochasticState.hasRisenAbove30 = false;

      // ✅ Confirm RSI & EMA conditions for SELL
      const isRSISell = lastRSI < 45;
      const isEMADowntrend = lastEMA9 < lastEMA14 && lastEMA14 < lastEMA21;

      if (isRSISell && isEMADowntrend) {
        console.log("Stochastic:", lastK);
        console.log("RSI:", lastRSI);
        console.log("Upper Bollinger Band:", lastBollingerUpper);
        console.log("Lower Bollinger Band:", lastBollingerLower);
        console.log("EMA9:", lastEMA9);
        console.log("EMA14:", lastEMA14);
        console.log("EMA21:", lastEMA21);
        console.log("---------------------------");
        console.log(`🚨 SELL Signal Triggered at ${currentTime}`);
        console.log("---------------------------");
        return "SELL";
      }
    }

  // **SIDEWAYS MARKET STRATEGY (marketValue ≤ 2)**
  } else {
    if(trend !== "sideways" || trend === null){
      trend = "sideways";
      stochasticState.hasCrossedAbove80 = false;
      stochasticState.hasDroppedBelow70 = false;
      stochasticState.hasCrossedBelow20 = false;
      stochasticState.hasRisenAbove30 = false;
      console.log(`Market Value: ${marketValue}`);
      console.log("--------------------------------------------------------");
      console.log(`📉 Sideways Market Strategy detected at ${currentTime}`);
      console.log("--------------------------------------------------------");
    }
    // ✅ Check BUY conditions
    if (lastK < 20 && !stochasticState.hasCrossedBelow20) {
      stochasticState.hasCrossedBelow20 = true;
      console.log(`✅ Stochastic crossed below 20 at ${currentTime}`);
    }

    if (stochasticState.hasCrossedBelow20 &&  lastK > 20) {
      console.log(`✅ Stochastic rose above 20 after crossing below at ${currentTime}`);

      // Reset state variables
      stochasticState.hasCrossedAbove80 = false;
      stochasticState.hasDroppedBelow70 = false;
      stochasticState.hasCrossedBelow20 = false;
      stochasticState.hasRisenAbove30 = false;

      // ✅ Confirm RSI & EMA conditions for BUY
      const isRSIBuy = lastRSI < 45;

      if (isRSIBuy) {
        console.log("Stochastic:", lastK);
        console.log("RSI:", lastRSI);
        console.log("Upper Bollinger Band:", lastBollingerUpper);
        console.log("Lower Bollinger Band:", lastBollingerLower);
        console.log("---------------------------");
        console.log(`🚀 BUY Signal Triggered at ${currentTime}`);
        console.log("---------------------------");
        return "BUY";
      }
    }

    // ✅ Check SELL conditions
    if (lastK > 80 && !stochasticState.hasCrossedAbove80) {
      stochasticState.hasCrossedAbove80 = true;
      console.log(`✅ Stochastic crossed above 80 at ${currentTime}`);
    }

    if (stochasticState.hasCrossedAbove80 && lastK < 80) {
      console.log(`✅ Stochastic went below 80 after crossing above at ${currentTime}`);

      // Reset state variables
      stochasticState.hasCrossedAbove80 = false;
      stochasticState.hasDroppedBelow70 = false;
      stochasticState.hasCrossedBelow20 = false;
      stochasticState.hasRisenAbove30 = false;

      // ✅ Confirm RSI & EMA conditions for SELL
      const isRSISell = lastRSI < 45;

      if (isRSISell) {
        console.log("Stochastic:", lastK);
        console.log("RSI:", lastRSI);
        console.log("Upper Bollinger Band:", lastBollingerUpper);
        console.log("Lower Bollinger Band:", lastBollingerLower);
        console.log("---------------------------");
        console.log(`🚨 SELL Signal Triggered at ${currentTime}`);
        console.log("---------------------------");
        return "SELL";
      }
    }

  }

  // Default to HOLD
  return "HOLD";
}



// Function to process market data
const processMarketData = async () => {
  const now = DateTime.now().toSeconds(); // Current time in seconds
  const twentytwoMinutesAgo = now - (22 * 60); // 22 minutes ago in seconds

  // Filter marketPrices to only include prices from the last 22 minutes
  const recentPrices = marketPrices.filter(price => price.timestamp >= twentytwoMinutesAgo);

  // Aggregate tick data into 1-minute OHLC candles
  const ohlcData = aggregateOHLC(recentPrices);

  if (ohlcData.length < 126) {
    console.log("Insufficient data for calculations");
    console.log("OHLC Data Length:", ohlcData.length);
    return; // Ensure enough data for calculations
  }

  // ✅ Fetch indicator values from the module
  const conditions = await calculateIndicators(ohlcData);
  const { rsi, stochastic, ema9, ema14, ema21, bollingerBands } = conditions;

  // ✅ Check trade signal using the calculated values
  const call = checkTradeSignal(stochastic, rsi, ema9, ema14, ema21, bollingerBands);

  if (call !== "HOLD") {
    // Reset state variables after placing a trade
    stochasticState.hasCrossedAbove80 = false;
    stochasticState.hasDroppedBelow70 = false;
    stochasticState.hasCrossedBelow20 = false;
    stochasticState.hasRisenAbove30 = false;

    API_TOKENS.forEach(accountId => {
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
                const now = DateTime.now().toSeconds(); // Current time in seconds
                const twentytwoMinutesAgo = now - (22 * 60); // 22 minutes ago in seconds
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
                marketPrices = marketPrices.filter(price => price.timestamp >= twentytwoMinutesAgo);
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
  