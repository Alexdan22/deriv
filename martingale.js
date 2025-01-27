// Function to handle trade results
const handleTradeResult = async (tradeKey, contract) => {
    console.log(tradeKey, contract);
    
    const trade = trades.get(tradeKey);
    if (!trade) {
      return;
    }
  
    console.log(`Processing trade result for ${tradeKey}:`, trade);
  
    if (contract.is_expired || contract.is_sold) {
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