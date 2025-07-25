import 'dotenv/config';
import OpenAI from 'openai';

const openai = new OpenAI();

async function testOpenAI() {
  console.log('🔍 Testing OpenAI API Key...\n');
  
  // Check if API key is set
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY environment variable is not set');
    console.log('💡 Create a .env file with your OpenAI API key:');
    console.log('   OPENAI_API_KEY=your_api_key_here');
    process.exit(1);
  }
  
  console.log('✅ API key environment variable found');
  console.log(`🔑 API key starts with: ${process.env.OPENAI_API_KEY.substring(0, 8)}...`);
  
  try {
    // Test 1: List models (minimal API call)
    console.log('\n📋 Testing API connection with models.list()...');
    const models = await openai.models.list();
    console.log('✅ API connection successful');
    console.log(`📊 Available models: ${models.data.length}`);
    
    // Test 2: Check if Whisper model is available
    const whisperModel = models.data.find(model => model.id === 'whisper-1');
    if (whisperModel) {
      console.log('✅ Whisper-1 model is available');
    } else {
      console.log('⚠️  Whisper-1 model not found in available models');
    }
    
    // Test 3: Try a minimal completion call to check credits
    console.log('\n💰 Testing account credits with minimal completion...');
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 1
    });
    
    console.log('✅ Account has sufficient credits');
    console.log(`📝 Test response: "${completion.choices[0].message.content}"`);
    
    console.log('\n🎉 All tests passed! Your OpenAI API key is working correctly.');
    console.log('🤖 The Discord bot should work properly now.');
    
  } catch (error) {
    console.error('\n❌ OpenAI API Error:', error.message);
    
    if (error.status === 401) {
      console.log('\n🔑 Invalid API Key Issues:');
      console.log('   • Check that your API key is correct');
      console.log('   • Make sure the API key is active');
      console.log('   • Verify the API key has the correct permissions');
      console.log('   • Check your OpenAI account status at https://platform.openai.com/account');
    } else if (error.status === 429) {
      console.log('\n💳 Rate Limit/Credit Issues:');
      console.log('   • You may have exceeded your rate limit');
      console.log('   • Your account may be out of credits');
      console.log('   • Add credits at https://platform.openai.com/account/billing');
      console.log('   • Check your usage at https://platform.openai.com/account/usage');
    } else if (error.code === 'insufficient_quota') {
      console.log('\n💰 Insufficient Credits:');
      console.log('   • Your OpenAI account is out of credits');
      console.log('   • Add credits at https://platform.openai.com/account/billing');
      console.log('   • Check your current balance and usage');
    } else if (error.message.includes('Connection') || error.code === 'ENOTFOUND') {
      console.log('\n🌐 Connection Issues:');
      console.log('   • Check your internet connection');
      console.log('   • Verify firewall settings');
      console.log('   • Try again in a few moments');
    } else {
      console.log('\n🔍 Other Error Details:');
      console.log(`   • Error Code: ${error.code || 'N/A'}`);
      console.log(`   • Error Status: ${error.status || 'N/A'}`);
      console.log(`   • Error Type: ${error.constructor.name}`);
    }
    
    console.log('\n🔗 Helpful Links:');
    console.log('   • OpenAI Platform: https://platform.openai.com/');
    console.log('   • API Keys: https://platform.openai.com/account/api-keys');
    console.log('   • Billing: https://platform.openai.com/account/billing');
    console.log('   • Usage: https://platform.openai.com/account/usage');
    
    process.exit(1);
  }
}

testOpenAI(); 