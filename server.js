const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const axios = require('axios');

const API_TOKEN = 'VX41WSwVGQDET3r'; // Replace with your Deriv API token
const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

const app = express();
app.use(bodyParser.json());

const trades = new Map(); // Track each trade by its symbol or unique ID

let ws; // WebSocket instance
const PING_INTERVAL = 30000; // Send a ping every 30 seconds
let pingInterval; // Store the interval ID

// Helper function: Send data to WebSocket
const sendToWebSocket = (ws, data) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  } else {
    console.warn('WebSocket is not open. Data not sent:', data);
  }
};

// Helper function: Parse durations
const parseDuration = (duration) => {
  const unit = duration.slice(-1);
  const value = parseInt(duration.slice(0, -1), 10);
  switch (unit) {
    case 't': return value;
    case 's': return value / 60;
    case 'm': return value;
    case 'h': return value * 60;
    case 'd': return value * 1440;
    default: return Infinity;
  }
};

// Function to fetch minimum duration for a symbol
const getMinDuration = (ws, symbol) => {
  return new Promise((resolve, reject) => {
    const listener = (event) => {
      const response = JSON.parse(event.data);

      if (response.error) {
        ws.removeEventListener('message', listener);
        reject(`Error: ${response.error.message}`);
      } else if (response.msg_type === 'contracts_for') {
        ws.removeEventListener('message', listener);

        const availableContracts = response.contracts_for.available;
        const minDuration = availableContracts.reduce((min, contract) => {
          const duration = parseDuration(contract.min_contract_duration);
          return duration < min ? duration : min;
        }, Infinity);

        resolve(minDuration);
      }
    };

    ws.addEventListener('message', listener);

    sendToWebSocket(ws, {
      contracts_for: symbol,
      currency: 'USD',
    });
  });
};

// Function to place a trade
const placeTrade = async (ws, trade) => {
  const { symbol, call, stake, duration, martingaleStep } = trade;

  const contractType = call === 'call' ? 'CALL' : 'PUT';
  const placeholderKey = `${symbol}-placeholder`;

  // Store a placeholder entry in trades
  trades.set(placeholderKey, { ...trade });
  console.log(`Placeholder added to trades: ${placeholderKey}`);

  try {
    console.log(`Placing trade: Symbol: ${symbol}, Step: ${martingaleStep}, Stake: ${stake}, Duration: ${duration}`);
    sendToWebSocket(ws, {
      buy: 1,
      price: stake,
      parameters: {
        amount: stake,
        basis: 'stake',
        contract_type: contractType,
        currency: 'USD',
        duration: duration,
        duration_unit: 'm',
        symbol: symbol,
      },
    });
  } catch (error) {
    console.error(`Error placing trade for ${symbol}:`, error);
  }
};



// Function to handle trade results
const handleTradeResult = async (tradeKey, contract) => {
  const trade = trades.get(tradeKey);
  if (!trade) {
    console.warn(`Trade result received for unknown tradeKey: ${tradeKey}`);
    return;
  }

  console.log(`Processing trade result for ${tradeKey}:`, trade);

  if (contract.is_expired && contract.is_sold) {
    const tradePnL = contract.profit;
    trade.totalPnL += tradePnL;

    if (tradePnL > 0) {
      console.log(`Trade for ${trade.symbol} won. PnL: ${tradePnL.toFixed(2)} USD.`);
      trades.delete(tradeKey); // Stop tracking this trade
    } else {
      trade.martingaleStep++;
      if (trade.martingaleStep <= trade.maxMartingaleSteps) {
        trade.stake *= 2; // Double the stake
        console.log(
          `Trade for ${trade.symbol} lost. Entering Martingale step ${trade.martingaleStep} with stake ${trade.stake} USD.`
        );
        placeTrade(ws, trade); // Place the next trade in the sequence
      } else {
        console.log(
          `All Martingale steps for ${trade.symbol} lost. Total PnL: ${trade.totalPnL.toFixed(
            2
          )} USD. Returning to idle state.`
        );
        trades.delete(tradeKey); // Stop tracking this trade
      }
    }
  }
};


// Function to create WebSocket connection
const createWebSocket = () => {
  ws = new WebSocket(WEBSOCKET_URL);

  ws.on('open', () => {
    console.log('Connected to Deriv API.');
    sendToWebSocket(ws, { authorize: API_TOKEN });

    clearInterval(pingInterval); // Clear any existing intervals
    pingInterval = setInterval(() => {
      sendToWebSocket(ws, { ping: 1 });
      sendToWebSocket(ws, { proposal_open_contract: 1, subscribe: 1 });
    }, PING_INTERVAL);
  });

  ws.on('message', (data) => {
    const response = JSON.parse(data);
  
    // Handle 'buy' response
    if (response.msg_type === 'buy') {
      const { contract_id, underlying: symbol } = response.buy;
    
      if (!symbol || !contract_id) {
        console.error('Buy response is missing required fields:', response.buy);
        return;
      }
    
      const placeholderKey = `${symbol}-placeholder`;
      const uniqueKey = `${symbol}-${contract_id}`;
    
      if (trades.has(placeholderKey)) {
        const trade = trades.get(placeholderKey);
    
        // Replace placeholder key with the unique key
        trades.set(uniqueKey, trade);
        trades.delete(placeholderKey);
    
        console.log(`Trade updated in trades map: ${placeholderKey} -> ${uniqueKey}`);
        console.log('Updated trades map:', Array.from(trades.keys()));
      } else {
        console.warn(`Buy response received for unknown trade: Symbol: ${symbol}, Contract ID: ${contract_id}`);
        console.log('Current trades map:', Array.from(trades.keys()));
      }
    }
    
    
  
    // Handle 'proposal_open_contract' response
    if (response.msg_type === 'proposal_open_contract') {
      const contract = response.proposal_open_contract;
    
      if (!contract || !contract.underlying || !contract.contract_id) {
        console.error('Proposal open contract is missing required fields:', contract);
        return;
      }
    
      const uniqueKey = `${contract.underlying}-${contract.contract_id}`;
    
      if (trades.has(uniqueKey)) {
        console.log(`Processing open contract update for ${uniqueKey}`);
        handleTradeResult(trades.get(uniqueKey), contract);
      } else {
        console.warn(`Open contract update received for unknown trade: ${uniqueKey}`);
        console.log('Current trades map:', Array.from(trades.keys()));
      }
    }
    
    
  });
  
  

  ws.on('close', () => {
    console.error('WebSocket connection closed. Reconnecting in 5 seconds...');
    clearInterval(pingInterval);
    setTimeout(createWebSocket, 5000);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
};

// Webhook listener for TradingView alerts
app.post('/webhook', async (req, res) => {
  const { symbol, call } = req.body;

  if (!symbol || !call) {
    console.error('Invalid webhook payload:', req.body);
    return res.status(400).send('Invalid webhook payload');
  }

  const normalizedSymbol = 'frx' + symbol; // Normalize symbol
  console.log(`Webhook received for symbol: ${normalizedSymbol}, call: ${call}`);

  if (trades.has(normalizedSymbol)) {
    console.log(`Trade for ${normalizedSymbol} is already in progress.`);
  }

  const trade = {
    symbol: normalizedSymbol,
    call,
    stake: 10, // Initial stake
    martingaleStep: 0,
    maxMartingaleSteps: 3,
    totalPnL: 0,
  };

  trades.set(normalizedSymbol, trade);
  console.log('Updated trades map:', Array.from(trades.keys())); // Log trades map after update

  try {
    const minDuration = await getMinDuration(ws, normalizedSymbol); // Add 'frx' for WebSocket request
    trade.duration = minDuration;

    console.log(`Minimum duration for ${normalizedSymbol}: ${minDuration}`);
    placeTrade(ws, trade);
  } catch (error) {
    console.error('Error processing alert:', error);
    trades.delete(normalizedSymbol);
  }

  res.status(200).send('Webhook received and trade initiated.');
});


// Start the server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`TradingView webhook listener running on port ${PORT}`);
});

// Start WebSocket connection
createWebSocket();
