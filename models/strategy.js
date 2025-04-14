// Function to check trade signals based on indicators
function checkTradeSignal(stochastic, rsi) {
  if (!stochastic?.length || !rsi?.length) {
    console.log("Insufficient indicator values for calculation");
    return "HOLD";
  }

  const currentTime = DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss');
  const lastStochastic = stochastic[stochastic.length - 1];
  const lastK = lastStochastic.k;
  const lastD = lastStochastic.d;
  const lastRSI = rsi[rsi.length - 1];
  const lastSecondRSI = rsi[rsi.length - 2];

  //Conditions for Buy trigger

  if(lastD < 65 &&  !stochasticState.hasDroppedBelow65){
    stochasticState.hasDroppedBelow65 = true;
    console.log(`📉 📉 %D Stochastic value dropped below 65 at ${currentTime} 📉 📉`);
  }

  if(lastD > 80 && stochasticState.hasDroppedBelow65){
    console.log(`📈 📈 %D Stochastic value crossed above 80 at ${currentTime} 📈 📈`);
    console.log("Stochastic:", lastStochastic);
    console.log("RSI:", lastRSI + "," + lastSecondRSI);
    
    stochasticState.hasDroppedBelow65 = false,
    stochasticState.hasCrossedAbove80 = false,
    stochasticState.hasCrossedBelow20 = false,
    stochasticState.hasRisenAbove35 = false
    

    const isRSIBuy = lastRSI > 65 || lastSecondRSI > 65;


    if(isRSIBuy){
      console.log("---------------------------");
      console.log(`🟢 🔰 🟢 BUY Signal Triggered at ${currentTime} 🟢 🔰 🟢`);
      console.log("---------------------------\n");
      return "BUY";
    }

    // Reasons why the BUY signal was not triggered
    let reasons = [];

    if (!isRSIBuy) reasons.push("RSI value is less than 65");

    if (reasons.length > 0) {
        reasons.forEach(reason => console.log(`🟢 ❌ ${reason}`));
        console.log(`🟢 ❌ BUY Signal conditions not met at ${currentTime} ❌ 🟢\n`);
    }

  }

  //Conditions for Sell trigger

  if(lastD > 35 && !stochasticState.hasRisenAbove35 ){
    stochasticState.hasRisenAbove35 = true;
    console.log(`📉 📉 %D Stochastic value rose 35 at ${currentTime} 📉 📉`);
  }

  if(lastD < 20 && stochasticState.hasRisenAbove35){
    console.log(`📉 📉 %D Stochastic value dropped below 20 at ${currentTime} 📉 📉`);
    console.log("Stochastic:", lastStochastic);
    console.log("RSI:", lastRSI + "," + lastSecondRSI);
    
    stochasticState.hasDroppedBelow65 = false,
    stochasticState.hasCrossedAbove80 = false,
    stochasticState.hasCrossedBelow20 = false,
    stochasticState.hasRisenAbove35 = false

    const isRSISell = lastRSI < 35 || lastSecondRSI < 35;


    if(isRSISell){
      console.log("---------------------------");
      console.log(`🔴 🧧 🔴 SELL Signal Triggered at ${currentTime} 🔴 🧧 🔴`);
      console.log("---------------------------\n");
      return "SELL";
    }

    // Reasons why the SELL signal was not triggered
    let reasons = [];

    if (!isRSISell) reasons.push("RSI value is more than 55");

    if (reasons.length > 0) {
        reasons.forEach(reason => console.log(`🛑 ❌ ${reason}`));
        console.log(`🛑 ❌ SELL Signal conditions not met at ${currentTime} ❌ 🛑\n`);
    }

  }

  // Default to HOLD
  return "HOLD";
}

function checkBreakoutSignal(stochastic, rsi){
  if (!stochastic?.length) {
    console.log("Insufficient indicator values for calculation");
    return "HOLD";
  }
  const currentTime = DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss');
  const lastStochastic = stochastic[stochastic.length - 1];
  const lastK = lastStochastic.k;
  const lastD = lastStochastic.d;
  const lastRSI = rsi[rsi.length - 1];
  const lastSecondRSI = rsi[rsi.length - 2];

  //Conditions for Buy trigger

  if(lastD < 20 && lastK < 50 && !breakoutSignal.holdforBuy ){
    breakoutSignal.holdforBuy = true;
    console.log(`📉 📉 %D Stochastic value crossed below 20 at ${currentTime} 📉 📉`);
  }

  if(lastK > 50 && breakoutSignal.holdforBuy){
    console.log(`📈 📈 BREAKOUT -- %K Stochastic value crossed above 50 at ${currentTime} 📈 📈`);
    console.log("Stochastic:", lastStochastic);
    console.log("RSI:", lastRSI + "," + lastSecondRSI);
    breakoutSignal.holdforBuy = false;
    

    const isRSIBuy = lastRSI < 56 || lastSecondRSI < 56;
    const isRSIBuyLimit = lastRSI > 40 || lastSecondRSI > 40;


    if(lastD < 20 && isRSIBuy && isRSIBuyLimit){
      console.log("---------------------------");
      console.log(`🟢 🔰 🟢 BUY Signal Triggered at ${currentTime} 🟢 🔰 🟢`);
      console.log("---------------------------\n");
      return "BUY";
    }

    // Reasons why the BUY signal was not triggered
    let reasons = [];

    if (!isRSIBuy) reasons.push("RSI value is less than 56");
    if (!isRSIBuyLimit) reasons.push("RSI value is more than 40");
    if (lastD > 20) reasons.push("Stochastic %D value is more than 20");

    if (reasons.length > 0) {
        reasons.forEach(reason => console.log(`🟢 ❌ ${reason}`));
        console.log(`🟢 ❌ BUY Signal conditions not met at ${currentTime} ❌ 🟢\n`);
    }

  }

  //Conditions for Sell trigger

  if(lastD > 80 && lastK > 50 && !breakoutSignal.holdforSell ){
    breakoutSignal.holdforSell = true;
    console.log(`📈 📈 %D Stochastic value crossed above 80 at ${currentTime} 📈 📈`);
  }

  if(lastK < 50 && breakoutSignal.holdforSell){
    console.log(`📈 📈 BREAKOUT -- %K Stochastic value crossed below 50 at ${currentTime} 📈 📈`);
    console.log("Stochastic:", lastStochastic);
    console.log("RSI:", lastRSI + "," + lastSecondRSI);
    breakoutSignal.holdforSell = false;
    

    const isRSISell = lastRSI > 44 || lastSecondRSI > 44;
    const isRSISellLimit = lastRSI < 60 || lastSecondRSI < 60;


    if(lastD > 80 && isRSISell && isRSISellLimit){
      console.log("---------------------------");
      console.log(`🔴 🧧 🔴 SELL Signal Triggered at ${currentTime} 🔴 🧧 🔴`);
      console.log("---------------------------\n");
      return "SELL";
    }

    // Reasons why the SELL signal was not triggered
    let reasons = [];

    if (!isRSISell) reasons.push("RSI value is more than 44");
    if (!isRSISellLimit) reasons.push("RSI value is less than 60");
    if (lastD < 80) reasons.push("Stochastic %D value is less than 80");

    if (reasons.length > 0) {
        reasons.forEach(reason => console.log(`🛑 ❌ ${reason}`));
        console.log(`🛑 ❌ SELL Signal conditions not met at ${currentTime} ❌ 🛑\n`);
    }
  }


  // Default to HOLD
  return "HOLD";
}


module.exports = {
  checkTradeSignal,
  checkBreakoutSignal
};