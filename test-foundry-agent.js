/**
 * Test script: Invoke Foundry agent "Lumis" with a simple question
 *
 * Run: npx ts-node test-foundry-agent.ts
 */
const endpoint = "https://kindred-1882-resource.cognitiveservices.azure.com";
const apiKey = process.env.FOUNDRY_API_KEY;
const deployment = "gpt-5-mini";
const apiVersion = "2024-02-15-preview";
async function testAgent() {
    console.log("🚀 Testing Azure OpenAI Model Deployment...\n");
    console.log(`📍 Endpoint: ${endpoint}`);
    console.log(`📦 Deployment: ${deployment}`);
    console.log(`📌 API Version: ${apiVersion}\n`);
    if (!apiKey) {
        console.error("❌ Error: FOUNDRY_API_KEY environment variable not set");
        console.error("   Add to .env: FOUNDRY_API_KEY=your-api-key");
        process.exit(1);
    }
    try {
        console.log("🔐 Using API Key authentication...\n");
        console.log("📤 Sending request...");
        // Construct invoke URL for OpenAI chat completions
        const invokeUrl = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
        const response = await fetch(invokeUrl, {
            method: "POST",
            headers: {
                "api-key": apiKey,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                messages: [
                    {
                        role: "user",
                        content: "Hello! Tell me what you can help with.",
                    },
                ],
            }),
        });
        console.log(`📥 Response Status: ${response.status}\n`);
        const data = await response.json();
        if (!response.ok) {
            console.error("❌ Error Response:");
            console.error(JSON.stringify(data, null, 2));
            process.exit(1);
        }
        console.log("✅ Agent Response:");
        console.log("----------------------------------------");
        // Handle different response formats
        if (data.choices && data.choices.length > 0) {
            const choice = data.choices[0];
            if (choice.message && choice.message.content) {
                console.log(choice.message.content);
            }
            else if (choice.text) {
                console.log(choice.text);
            }
            else {
                console.log(JSON.stringify(choice, null, 2));
            }
        }
        else if (data.output_text) {
            console.log(data.output_text);
        }
        else {
            console.log(JSON.stringify(data, null, 2));
        }
        console.log("----------------------------------------\n");
        console.log("🎉 Test completed successfully!");
    }
    catch (error) {
        console.error("\n❌ Error:", error.message);
        process.exit(1);
    }
}
testAgent();
