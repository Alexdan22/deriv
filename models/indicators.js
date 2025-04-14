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

module.exports = {
  calculateIndicators,
  calculateExactRSI
};