const axios = require('axios');

async function testGraphAPI() {
    try {
        console.log('🧪 Testing Dynamic Graph API...');
        
        const payload = {
            query: "Give me patients with medications as well",
            organizationId: "cmdrg9zvp0000xgft43jmuu09",
            conversational: true
            // No hardcoded graph parameters - let AI decide dynamically
        };

        console.log('📤 Sending request with payload:', JSON.stringify(payload, null, 2));
        
        const response = await axios.post('http://localhost:3001/api/medical/query-sql-manual', payload, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        console.log('✅ Response received!');
        console.log('📊 Graph processing info:', response.data.graph_processing);
        
        if (response.data.sql_results.graph_data) {
            console.log('📈 Graph data found!');
            console.log('📊 Graph type:', response.data.sql_results.graph_data.type);
            console.log('📊 Graph config:', response.data.sql_results.graph_data.config);
            console.log('📊 Sample data points:', response.data.sql_results.graph_data.data.slice(0, 3));
            
            // Check if we have non-zero values
            const nonZeroData = response.data.sql_results.graph_data.data.filter(item => item.y > 0);
            console.log(`📊 Non-zero data points: ${nonZeroData.length}/${response.data.sql_results.graph_data.data.length}`);
            
            if (nonZeroData.length > 0) {
                console.log('✅ SUCCESS: Graph data contains meaningful values!');
                console.log('📊 Sample non-zero data:', nonZeroData.slice(0, 3));
            } else {
                console.log('❌ ISSUE: All graph data values are zero');
            }
        } else {
            console.log('❌ No graph data in response');
        }
        
    } catch (error) {
        console.error('❌ Test failed:', error.response?.data || error.message);
    }
}

testGraphAPI(); 