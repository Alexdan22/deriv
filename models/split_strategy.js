const { DateTime } = require('luxon');
const ti = require('technicalindicators');

function checkTradeSignal(stochastic, ema9, ema14, ema21, rsi) {
  if (!stochastic?.length|| !ema9?.length || !ema14?.length || !ema21?.length || !rsi?.length) {
    console.log("Insufficient indicator values for calculation");
    return "HOLD";
  }

  // Get latest indicator values
  const currentTime = DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss');
  const lastStochastic = stochastic[stochastic.length - 1]; 
  const lastK = lastStochastic.k;
  const lastD = lastStochastic.d;
  const lastRSI = rsi[rsi.length - 1];
  const lastSecondRSI = rsi[rsi.length - 2];
  const lastEMA9 = ema9[ema9.length - 1];
  const lastEMA14 = ema14[ema14.length - 1];
  const lastEMA21 = ema21[ema21.length - 1];
  const lastBollingerBand = latestBollingerBands[latestBollingerBands.length - 1];
  const lastBollingerUpper = lastBollingerBand.upper;
  const lastBollingerLower = lastBollingerBand.lower;
  const marketValue = lastBollingerUpper - lastBollingerLower;
  
  // Determine market trend
  
  

  if (trend == 'SLOW_TREND') {
    // **TRENDING MARKET STRATEGY**


    // ✅ Check BUY conditions
    if (lastK > 80 && stochasticState.condition != 80) {
      stochasticState.condition = 80;
      console.log(`📈 📈 Stochastic crossed above 80 at ${currentTime} 📈 📈`);
    }

    if (stochasticState.condition == 80 && lastK < 70 && !stochasticState.hasDroppedBelow70) {
      stochasticState.hasDroppedBelow70 = true;
      console.log(`📉 📉 Stochastic dropped below 70 at ${currentTime} 📉 📉`);
    }

    if (stochasticState.condition == 80 && stochasticState.hasDroppedBelow70 && lastK > 80) {

      // Reset state variables
      stochasticState.hasDroppedBelow70 = false;
      stochasticState.hasRisenAbove30 = false;

      // ✅ Confirm RSI & EMA conditions for BUY
      const isRSIBuy = lastRSI > 53 || lastSecondRSI > 53;
      const isRSIBuyLimit = lastRSI < 66 || lastSecondRSI < 66;
      const isEMAUptrend = lastEMA9 > lastEMA14 && lastEMA14 > lastEMA21;
      const isEMADowntrend = lastEMA9 < lastEMA14 && lastEMA14 < lastEMA21;

      console.log(`📈 📈 Stochastic rose back above 80 at ${currentTime} 📈 📈`);
      console.log("Stochastic:", lastStochastic);
      console.log("RSI:", lastRSI + "," + lastSecondRSI);
      console.log("Bollinger Band value:", marketValue);
      if(isEMAUptrend){
        console.log(`📈 Uptrend Market detected`);
      }else if(isEMADowntrend){
        console.log(`📉 Downtrend market detected`);
      }else{
        console.log(`Trend not clear`);
      }


      if (isRSIBuy && isRSIBuyLimit && isEMAUptrend && marketValue > 1.5) {
        console.log("---------------------------");
        console.log(`🟢 🔰 🟢 BUY Signal Triggered at ${currentTime} 🟢 🔰 🟢`);
        console.log("---------------------------\n");
        return "BUY";
      }
      
      // Reasons why the BUY signal was not triggered
      const reasons = [];
      
      if (!isRSIBuy) reasons.push("RSI value is less than 53");
      if (!isRSIBuyLimit) reasons.push("RSI value is more than 66");
      if (!isEMAUptrend) reasons.push("EMAs are not in uptrend");
      if (marketValue < 1.5) reasons.push("Bollinger Band value is less than 1.5");
      
      if (reasons.length) {
        reasons.forEach(reason => console.log(`🟢 ❌ ${reason}`));
        console.log(`🟢 ❌ BUY Signal conditions not met at ${currentTime} ❌ 🟢\n`);
      }
    }

    // ✅ Check SELL conditions
    if (lastK < 20 && stochasticState.condition != 20) {
      stochasticState.condition = 20;
      console.log(`📉 📉 Stochastic crossed below 20 at ${currentTime} 📉 📉`);
    }

    if (stochasticState.condition == 20 && lastK > 30 && !stochasticState.hasRisenAbove30) {
      stochasticState.hasRisenAbove30 = true;
      console.log(`📈 📈 Stochastic rose above 30 after crossing below at ${currentTime} 📈 📈`);
    }

    if (stochasticState.condition == 20 && stochasticState.hasRisenAbove30 && lastK < 20) {
      
      // ✅ Confirm RSI & EMA conditions for SELL
      const isRSISell = lastRSI < 47 || lastSecondRSI < 47;
      const isRSISellLimit = lastRSI > 34 || lastSecondRSI > 34;
      const isEMAUptrend = lastEMA9 > lastEMA14 && lastEMA14 > lastEMA21;
      const isEMADowntrend = lastEMA9 < lastEMA14 && lastEMA14 < lastEMA21;

      // Reset state variables
      stochasticState.hasDroppedBelow70 = false;
      stochasticState.hasRisenAbove30 = false;
      
      console.log(`📉 📉 Stochastic dropped back below 20 at ${currentTime} 📉 📉`);
      console.log("Stochastic:", lastStochastic);
      console.log("RSI:", lastRSI + "," + lastSecondRSI);
      console.log("Bollinger Band value:", marketValue);
      if(isEMAUptrend){
        console.log(`📈 Uptrend Market detected`);
      }else if(isEMADowntrend){
        console.log(`📉 Downtrend market detected`);
      }else{
        console.log(`Trend not clear`);
      }


      if (isRSISell && isRSISellLimit && isEMADowntrend && marketValue > 1.5) {
        console.log("---------------------------");
        console.log(`🔴 🧧 🔴 SELL Signal Triggered at ${currentTime} 🔴 🧧 🔴`);
        console.log("---------------------------\n");
        return "SELL";
      }
      
      // Reasons why the SELL signal was not triggered
      const reasons = [];
      
      if (!isRSISell) reasons.push("RSI value is more than 47");
      if (!isRSISellLimit) reasons.push("RSI value is less than 34");
      if (!isEMADowntrend) reasons.push("EMAs are not in Downtrend");
      if (marketValue < 1.5) reasons.push("Bollinger Band value is less than 1.5");
      
      if (reasons.length) {
        reasons.forEach(reason => console.log(`🛑 ❌ ${reason}`));
        console.log(`🛑 ❌ SELL Signal conditions not met at ${currentTime} ❌ 🛑\n`);
      }
    }

  } else if(trend == 'SIDEWAYS') {
    // ** SIDEWAY MARKET STRATEGY**
    
    // ✅ Check BUY conditions
    if (lastK < 20 && (stochasticState.condition != 20 || !stochasticState.hasCrossedBelow20)) {
      stochasticState.condition = 20;
      stochasticState.hasCrossedBelow20 = true;
      console.log(`📉 📉 Stochastic crossed below 20 at ${currentTime} 📉 📉`);
    }

    if (lastK > 20 && stochasticState.hasCrossedBelow20) {
      console.log(`📈 📈 Stochastic rose above 20 at ${currentTime} 📈 📈`);
      console.log("Stochastic:", lastStochastic);
      console.log("RSI:", lastRSI + "," + lastSecondRSI);
      console.log("Bollinger Band:", marketValue);

      // Reset state variables
      stochasticState.hasDroppedBelow70 = false;
      stochasticState.hasRisenAbove30 = false;
      stochasticState.hasCrossedBelow20 = false;

      // ✅ Confirm RSI & EMA conditions for BUY
      const isRSIBuy = lastRSI < 50 || lastSecondRSI < 50;
      const isRSIBuyLimit = lastRSI > 37 || lastSecondRSI > 37;

      if (isRSIBuy && isRSIBuyLimit && lastD < 80 && lastD > 20 && marketValue > 2) {
        console.log("---------------------------");
        console.log(`🟢 🔰 🟢 BUY Signal Triggered at ${currentTime} 🟢 🔰 🟢`);
        console.log("---------------------------\n");
        return "BUY";
      }
      
      // Reasons why the BUY signal was not triggered
      const reasons = [];
      
      if (!isRSIBuy) reasons.push("RSI value is more than 50");
      if (!isRSIBuyLimit) reasons.push("RSI value is less than 37");
      if (lastD > 80) reasons.push("Stochastic %D value is more than 80");
      if (lastD < 20) reasons.push("Stochastic %D value is less than 20");
      if (marketValue < 2) reasons.push("Bollinger Band value is less than 2");
      
      if (reasons.length) {
        reasons.forEach(reason => console.log(`🟢 ❌ ${reason}`));
        console.log(`🟢 ❌ BUY Signal conditions not met at ${currentTime} ❌ 🟢\n`);
      } 
    }

    // ✅ Check SELL conditions
    if (lastK > 80 && (stochasticState.condition != 80 ||  !stochasticState.hasCrossedAbove80)) {
      stochasticState.condition = 80;
      stochasticState.hasCrossedAbove80 = true;
      console.log(`📈 📈 Stochastic crossed above 80 at ${currentTime} 📈 📈`);
    }

    if ( lastK < 80 && stochasticState.hasCrossedAbove80) {
      console.log(`📉 📉 Stochastic went below 80 at ${currentTime} 📉 📉`);
      console.log("Stochastic:", lastStochastic);
      console.log("RSI:", lastRSI + "," + lastSecondRSI);
      console.log("Bollinger Band:", marketValue);

      // Reset state variables
      stochasticState.hasCrossedAbove80 = false;

      // ✅ Confirm RSI & EMA conditions for SELL

      const isRSISell = lastRSI > 50 || lastSecondRSI > 50;
      const isRSISellLimit = lastRSI < 63 || lastSecondRSI < 63;

      if (isRSISell && isRSISellLimit && lastD < 80 && lastD > 20 && marketValue > 2) {
        console.log("---------------------------");
        console.log(`🔴 🧧 🔴 SELL Signal Triggered at ${currentTime} 🔴 🧧 🔴`);
        console.log("---------------------------\n");
        return "SELL";
      }
      
      // Reasons why the SELL signal was not triggered
      const reasons = [];
      
      if (!isRSISell) reasons.push("RSI value is less than 50");
      if (!isRSISellLimit) reasons.push("RSI value is more than 63");
      if (lastD > 80) reasons.push("Stochastic %D value is more than 80");
      if (lastD < 20) reasons.push("Stochastic %D value is less than 20");
      if (marketValue < 2) reasons.push("Bollinger Band value is less than 2");
      
      if (reasons.length) {
        reasons.forEach(reason => console.log(`🛑 ❌ ${reason}`));
        console.log(`🛑 ❌ SELL Signal conditions not met at ${currentTime} ❌ 🛑\n`);
      }      
    }

  }

  // Default to HOLD
  return "HOLD";
}