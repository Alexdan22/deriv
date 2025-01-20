// Import the WebSocket library
const WebSocket = require('ws');

// Replace 'your-api-token-here' with your actual Deriv API token
const API_TOKEN = 'VX41WSwVGQDET3r'; //Demo account api token
const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

// Create a WebSocket connection
const ws = new WebSocket(WEBSOCKET_URL);

let isTrading = false; // Prevent overlapping trades
let tradeID = null; // Store the trade ID

// Function to send data to WebSocket
const sendToWebSocket = (data) => {
  ws.send(JSON.stringify(data));
};

// Function to place a trade
const placeTrade = (symbol, contractType, amount) => {
  console.log('Placing trade...');
  sendToWebSocket({
    buy: 1,
    price: amount,
    parameters: {
      amount,
      basis: 'stake',
      contract_type: contractType, // 'CALL' or 'PUT'
      currency: 'USD',
      duration: 1,
      duration_unit: 'm',
      symbol,
    },
  });
};

// Function to handle trade result and reset the bot
const handleTradeResult = (result) => {
  if (result.profit > 0) {
    console.log(`Trade won! Profit: ${result.profit}`);
  } else {
    console.log(`Trade lost. Loss: ${result.profit}`);
  }
  console.log('Returning to idle state...');

  // Reset state
  isTrading = false;
  tradeID = null;

  // Wait 1 minute before checking the market again
  setTimeout(() => {
    console.log('Ready for the next trade.');
  }, 60000); // 1 minute delay
};

// Listen to WebSocket messages
ws.on('message', (data) => {
  const response = JSON.parse(data);
  console.log('Response:', response);

  if (response.msg_type === 'authorize') {
    console.log('Authorized!');
    // Request ticks for a specific market
    sendToWebSocket({
      ticks: 'R_100', // Replace with your preferred market symbol
    });
  }

  if (response.msg_type === 'tick' && !isTrading) {
    const price = response.tick.quote;
    console.log(`Tick: ${response.tick.symbol} | Price: ${price}`);

    // Example condition to trigger a trade
    if (price > 100) { // Replace with your trading condition
      isTrading = true;
      placeTrade('R_100', 'CALL', 10); // Replace with your trade parameters
    }
  }

  if (response.msg_type === 'buy') {
    console.log('Trade placed successfully:', response.buy);
    tradeID = response.buy.transaction_id;
  }

  if (response.msg_type === 'proposal_open_contract' && response.proposal_open_contract.contract_id === tradeID) {
    const contract = response.proposal_open_contract;

    if (contract.status === 'sold') {
      // Trade completed
      handleTradeResult(contract);
    }
  }

  if (response.msg_type === 'error') {
    console.error('Error:', response.error.message);
    isTrading = false; // Reset trading state in case of error
  }
});

// Handle WebSocket connection open
ws.on('open', () => {
  console.log('WebSocket connected.');
  // Authorize with your API token
  sendToWebSocket({
    authorize: API_TOKEN,
  });
});

// Handle WebSocket errors
ws.on('error', (error) => {
  console.error('WebSocket Error:', error);
  isTrading = false; // Reset trading state in case of error
});

// Handle WebSocket close
ws.on('close', () => {
  console.log('WebSocket connection closed.');
});
