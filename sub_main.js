const WebSocket = require('ws');
const API_TOKEN = 'VX41WSwVGQDET3r';
const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

const ws = new WebSocket(WEBSOCKET_URL);

let isTrading = false;
let currentContractId = null;
let contractStartTime = null;

// Send data to WebSocket
const sendToWebSocket = (data) => {
  ws.send(JSON.stringify(data));
};

// Subscribe to ticks for a specific symbol
const subscribeToTicks = (symbol) => {
  sendToWebSocket({ ticks: symbol });
  console.log(`Subscribed to tick updates for ${symbol}.`);
};

// Request contract details to monitor its status
const monitorContract = (contractId) => {
  sendToWebSocket({
    proposal_open_contract: 1,
    contract_id: contractId,
  });
  console.log(`Monitoring contract: ${contractId}`);
};

// Cancel all ongoing trades
const cancelOngoingTrades = () => {
  sendToWebSocket({ portfolio: 1 });  // Get active trades (contracts)
  console.log('Checking for ongoing trades to cancel...');
};

// Handle WebSocket messages
ws.on('message', (data) => {
  const response = JSON.parse(data);

  if (response.msg_type === 'authorize') {
    console.log('Authorized!');
    cancelOngoingTrades(); // Check and cancel any open trades before proceeding
  }

  if (response.msg_type === 'portfolio') {
    const contracts = response.portfolio.contracts;
    if (contracts && contracts.length > 0) {
      console.log('Canceling ongoing trades...');
      contracts.forEach((contract) => {
        // Cancel open trades
        sendToWebSocket({ sell: contract.contract_id, price: 0 });
        console.log(`Cancelled contract with ID: ${contract.contract_id}`);
      });
    } else {
      console.log('No ongoing trades. Ready to place a new trade.');
      subscribeToTicks('R_100'); // Start listening for ticks
    }
  }

  else if  (response.msg_type === 'tick' && !isTrading) {
    const tick = response.tick;
    console.log(`Tick: ${tick.symbol} | Price: ${tick.quote}`);
    // Trade condition
    if (tick.quote > 1670) {
      console.log('Condition met. Placing trade...');
      
      console.log(`Tick: ${tick.symbol} | Price: ${tick.quote}`);

      isTrading = true;

      sendToWebSocket({
        buy: 1,
        price: 10,
        parameters: {
          amount: 10,
          basis: 'stake',
          contract_type: 'CALL',
          currency: 'USD',
          duration: 1,  // 1-minute trade duration
          duration_unit: 'm',
          symbol: 'R_100',
        },
      });
    }
  }

  else if (response.msg_type === 'buy') {
    console.log('Trade placed successfully:', response.buy);

    if (response.buy && response.buy.contract_id) {
      currentContractId = response.buy.contract_id;
      contractStartTime = response.buy.purchase_time;

      // Start monitoring the contract
      setTimeout(() => {
        monitorContract(currentContractId);
      }, 5000); // Wait a few seconds before requesting contract details
    } else {
      console.log('Trade placement failed, no contract_id found in the response.');
      isTrading = false;
    }
  }

  else if (response.msg_type === 'proposal_open_contract') {
    const contract = response.proposal_open_contract;
    console.log('Contract details:', contract);

    // Check if contract is expired (after 1 minute)
    const currentTime = Math.floor(Date.now() / 1000);  // Current timestamp in seconds
    const expirationTime = contract.start_time + contract.duration;
    
    // If the current time is greater than or equal to the expiration time, the trade should be closed
    if (contract.status !== 'open' || currentTime >= expirationTime) {
      console.log('Trade completed or expired.');
      const profit = contract.profit;

      if (profit > 0) {
        console.log(`Trade won! Profit: ${profit}`);
      } else {
        console.log(`Trade lost. Loss: ${profit}`);
      }

      isTrading = false;
      currentContractId = null;

      console.log('Returning to idle state...');
      setTimeout(() => {
        console.log('Ready for the next trade.');
      }, 60000); // Wait 1 minute before the next trade
    } else {
      console.log('Trade still active. Waiting for completion...');
      // Keep monitoring every few seconds
      setTimeout(() => {
        monitorContract(contract.contract_id);
      }, 5000);
    }
  }

  else if (response.msg_type === 'error') {
    console.error('Error:', response.error.message);
    isTrading = false;
  }
  
  else{
    console.log(response)
  }
});

// Handle WebSocket connection open
ws.on('open', () => {
  console.log('WebSocket connected.');
  sendToWebSocket({ authorize: API_TOKEN });
});

// Handle WebSocket errors
ws.on('error', (error) => {
  console.error('WebSocket Error:', error);
  isTrading = false;
});

// Handle WebSocket close
ws.on('close', () => {
  console.log('WebSocket connection closed.');
});
