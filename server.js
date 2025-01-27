const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const axios = require('axios');

const ACCOUNTS = [
  { name: 'Alex_demo', apiKey: 'VX41WSwVGQDET3r' },
  { name: 'Ajith_demo', apiKey: '44TRhSy7NFXLsSl' }
];

const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

const app = express();
app.use(bodyParser.json());

const trades = new Map();
const pendingTrades = new Map();

const accountSockets = new Map();
const PING_INTERVAL = 30000;

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

// Function to place a trade for a specific WebSocket (account)
const placeTradeForAccount = async (ws, trade) => {
  const { symbol, call, stake, duration } = trade;
  const contractType = call === 'call' ? 'CALL' : 'PUT';

  try {
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
  const uniqueKey = `${contract.underlying}-${contract.contract_id}`;
  trades.delete(uniqueKey);
  console.log(`Trade for ${contract.underlying} ${contract.status}. PnL: ${contract.profit} USD.`);
};

// Function to create WebSocket connection for a specific account
const createWebSocketForAccount = (account) => {
  const ws = new WebSocket(WEBSOCKET_URL);

  ws.on('open', () => {
    console.log(`Connected to Deriv API for ${account.name}.`);
    sendToWebSocket(ws, { authorize: account.apiKey });

    setInterval(() => {
      sendToWebSocket(ws, { ping: 1 });
      sendToWebSocket(ws, { proposal_open_contract: 1, subscribe: 1 });
    }, PING_INTERVAL);
  });

  ws.on('message', (data) => {
    const response = JSON.parse(data);

    if (response.msg_type === 'buy') {
      const { contract_id, longcode, shortcode } = response.buy;
    
    
    
      // Match trade context using the placeholder key or sliced symbol
      const tradeContext = Array.from(pendingTrades.entries()).find(([placeholderKey, context]) => {
        const slicedSymbol = context.symbol.replace('frx', ''); // Remove "frx" prefix
        return shortcode.includes(slicedSymbol); // Check if sliced symbol is in shortcode
      });
    
    
     
    
      const [placeholderKey, { symbol: matchedSymbol }] = tradeContext;
      const uniqueKey = `${matchedSymbol}-${contract_id}`;
    
      // Update trades map
      if (trades.has(placeholderKey)) {
        const trade = trades.get(placeholderKey);
    
        trades.set(uniqueKey, trade); // Add the unique key
        trades.delete(placeholderKey); // Remove the placeholder key
    
        console.log(`Trade updated in trades map: ${placeholderKey} -> ${uniqueKey}`);
        console.log('Updated trades map:', Array.from(trades.keys()));
    
        pendingTrades.delete(placeholderKey); // Remove from pendingTrades
      } else {
        console.warn(`Buy response received but placeholder key not found: ${placeholderKey}`);
      }  
    }

    if (response.msg_type === 'proposal_open_contract') {
      const contract = response.proposal_open_contract;
      if (!contract || !contract.underlying || !contract.contract_id) return;

      const uniqueKey = `${contract.underlying}-${contract.contract_id}`;
      if (trades.has(uniqueKey) && contract.status !== 'open') {
        handleTradeResult(trades.get(uniqueKey), contract);
      }
    }
  });

  ws.on('close', () => {
    console.error(`WebSocket for ${account.name} closed. Reconnecting in 5 seconds...`);
    setTimeout(() => createWebSocketForAccount(account), 5000);
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for ${account.name}:`, error);
  });

  accountSockets.set(account.name, ws);
};

// Initialize WebSocket connections for all accounts
const initializeWebSockets = () => {
  ACCOUNTS.forEach((account) => createWebSocketForAccount(account));
};

// Webhook listener for TradingView alerts
app.post('/webhook', async (req, res) => {
  const { symbol, call } = req.body;

  if (!symbol || !call) {
    console.error('Invalid webhook payload:', req.body);
    return res.status(400).send('Invalid webhook payload');
  }

  const normalizedSymbol = 'frx' + symbol;
  console.log(`Webhook received for symbol: ${normalizedSymbol}, call: ${call}`);

  const trade = {
    symbol: normalizedSymbol,
    call,
    stake: 10,
    martingaleStep: 0,
    maxMartingaleSteps: 3,
    totalPnL: 0,
  };

  try {
    const minDuration = await getMinDuration(accountSockets.get(ACCOUNTS[0].name), normalizedSymbol);
    trade.duration = minDuration;

    ACCOUNTS.forEach((account) => {
      const ws = accountSockets.get(account.name);
      if (ws) {
        placeTradeForAccount(ws, trade);
      } else {
        console.error(`No WebSocket for account: ${account.name}`);
      }
    });

    res.status(200).send('Trade initiated for all accounts.');
  } catch (error) {
    console.error('Error processing trade:', error);
    res.status(500).send('Failed to process trade.');
  }
});

// Start the server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`TradingView webhook listener running on port ${PORT}`);
});

// Start WebSocket connections for all accounts
initializeWebSockets();
