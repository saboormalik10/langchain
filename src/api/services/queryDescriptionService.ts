import multiTenantLangChainService from "../../services/multiTenantLangChainService";

/**
 * Query Description Service
 * Handles generating query descriptions and result explanations using LLM
 */

interface QueryDescriptionParams {
    generateDescription: boolean;
    finalSQL: string;
    query: string;
    rows: any[];
    organizationId: string;
}

interface QueryDescriptionResult {
    success: boolean;
    queryDescription: string;
    resultExplanation: string;
    errorMessage?: string;
}

/**
 * Generates query description and result explanation using LLM
 * @param params Query description parameters
 * @returns Query description result
 */
export async function generateQueryDescriptionAndExplanation(
    params: QueryDescriptionParams
): Promise<QueryDescriptionResult> {
    const { generateDescription, finalSQL, query, rows, organizationId } = params;

    // Generate description/explanation of the query and results
    console.log('📝 Step 5: Generating query description and result explanation...');
    let queryDescription = '';
    let resultExplanation = '';

    if (generateDescription) {
        try {
            // Get the LangChain app to access the LLM
            const langchainApp = await multiTenantLangChainService.getOrganizationLangChainApp(organizationId);
            const llm = (langchainApp as any).llm; // Access the Azure OpenAI LLM instance

            if (llm) {
                // Generate query description
                const queryDescriptionPrompt = `Medical database expert: Translate this SQL query into plain language that directly addresses the user's original question.

Original Question: "${query}"
SQL Query: ${finalSQL}

In 2-3 concise sentences, explain:
1. How this SQL query answers the user's specific question
2. Exactly what data is being retrieved and filtered
3. The medical relevance of this information

Be direct and precise. Avoid technical SQL terminology.`;

                const queryDescResponse = await llm.invoke(queryDescriptionPrompt);
                queryDescription = typeof queryDescResponse === 'string' ? queryDescResponse : queryDescResponse.content || '';
                console.log('✅ Generated query description');

                // Generate result explanation if we have results
                if (Array.isArray(rows) && rows.length > 0) {
                    const resultSample = rows.slice(0, 3); // Show first 3 rows as sample
                    const resultExplanationPrompt = `Medical data analyst: Interpret these results specifically in the context of the user's original question.

User Question: "${query}"
Total Results: ${rows.length}
Sample Results: ${JSON.stringify(resultSample, null, 2)}

Provide HTML formatted insights that:
<h3>Direct answer to the user's question</h3>
<p>
1. Directly address what the user wanted to know
2. Highlight the most relevant patterns or findings
3. Explain the medical significance of these results
</p>

Focus exclusively on answering the original question.
No SQL terminology or technical details.
No patient-identifying information.
Be concise and clinically relevant.`;

                    const resultExpResponse = await llm.invoke(resultExplanationPrompt);
                    resultExplanation = typeof resultExpResponse === 'string' ? resultExpResponse : resultExpResponse.content || '';
                    console.log('✅ Generated result explanation');
                } else {
                    resultExplanation = 'No results were found matching your query criteria.';
                }
            } else {
                console.log('⚠️ LLM not available for description generation');
                queryDescription = 'Query description not available';
                resultExplanation = 'Result explanation not available';
            }
        } catch (descError: any) {
            console.error('❌ Error generating descriptions:', descError.message);
            return {
                success: false,
                queryDescription: 'Error generating query description',
                resultExplanation: 'Error generating result explanation',
                errorMessage: descError.message
            };
        }
    } else {
        queryDescription = 'Query description generation disabled';
        resultExplanation = 'Result explanation generation disabled';
    }

    return {
        success: true,
        queryDescription,
        resultExplanation
    };
}