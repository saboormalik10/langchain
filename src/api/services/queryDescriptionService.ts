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
                const queryDescriptionPrompt = `You are a medical database expert. Analyze this SQL query and provide a clear, professional explanation of what it does.

SQL Query: ${finalSQL}

Original User Question: ${query}

Provide a concise explanation (2-3 sentences) of:
1. What data this query retrieves
2. What conditions/filters are applied
3. How the results are organized

Keep it professional and easy to understand for both technical and non-technical users.`;

                const queryDescResponse = await llm.invoke(queryDescriptionPrompt);
                queryDescription = typeof queryDescResponse === 'string' ? queryDescResponse : queryDescResponse.content || '';
                console.log('✅ Generated query description');

                // Generate result explanation if we have results
                if (Array.isArray(rows) && rows.length > 0) {
                    const resultSample = rows.slice(0, 3); // Show first 3 rows as sample
                    const resultExplanationPrompt = `You are a medical data analyst. Analyze these SQL query results and return a professional HTML summary.

Original Question: ${query}
SQL Query: ${finalSQL}
Total Results Found: ${rows.length}
Sample Results: ${JSON.stringify(resultSample, null, 2)}

Generate a clear, high-level explanation using HTML markup. Format the response as follows:
- A <h3> heading summarizing the result
- A short <p> paragraph (2–4 sentences) explaining:
  1. What was generally found in the data (without any individual-level detail)
  2. Key patterns or trends
  3. What this means in response to the user's question

Do NOT include any personal or sensitive data.
Avoid technical SQL details.
Keep the focus on medical/business relevance only.
Return only valid, semantic HTML.`;

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
