import { MedicalDatabaseLangChainApp } from '../index';
import { cleanSQLQuery } from './sqlUtils';

interface SQLValidationResult {
    isValid: boolean;
    issues: string[];
    suggestions: string[];
}

/**
 * Validates if the generated SQL query matches the original query criteria
 */
export async function validateSQLAgainstCriteria(
    sql: string,
    originalQuery: string,
    langchainApp: MedicalDatabaseLangChainApp,
    organizationId: string,
    dbConfig: any
): Promise<SQLValidationResult> {
    const issues: string[] = [];
    const suggestions: string[] = [];
    let isValid = true;

    try {
        console.log('🔍 Validating SQL against criteria...');
        console.log('📝 Original query:', originalQuery);
        console.log('🔧 Generated SQL:', sql);

        // 1. Check if SQL contains the main keywords from the original query
        const originalLower = originalQuery.toLowerCase();
        const sqlLower = sql.toLowerCase();

        // Extract key medical terms and conditions from original query
        const medicalTerms = originalQuery.match(/\b(patient|diagnosis|medication|treatment|procedure|test|result|symptom|condition|disease|doctor|physician|nurse|clinic|hospital|lab|laboratory|blood|urine|genetic|pgx|pharmacogenomic|dosage|allergy|adverse|reaction|age|gender|ethnicity|race)\w*/gi) || [];

        // Check if important medical terms are referenced in the SQL
        for (const term of medicalTerms) {
            if (!sqlLower.includes(term.toLowerCase())) {
                // Check if there's a related table or column that might contain this data
                const relatedFound = await checkForRelatedTerm(term, sql, langchainApp, organizationId);
                if (!relatedFound) {
                    issues.push(`Medical term "${term}" from original query not found in SQL`);
                    suggestions.push(`Consider adding reference to ${term} or related medical data`);
                    isValid = false;
                }
            }
        }

        // 2. Check for specific query patterns and requirements
        if (originalLower.includes('count') || originalLower.includes('how many')) {
            if (!sqlLower.includes('count(') && !sqlLower.includes('group by')) {
                issues.push('Original query asks for counting but SQL does not include COUNT() or GROUP BY');
                suggestions.push('Add COUNT() aggregation or GROUP BY clause');
                isValid = false;
            }
        }

        if (originalLower.includes('average') || originalLower.includes('mean')) {
            if (!sqlLower.includes('avg(')) {
                issues.push('Original query asks for average but SQL does not include AVG()');
                suggestions.push('Add AVG() aggregation function');
                isValid = false;
            }
        }

        if (originalLower.includes('maximum') || originalLower.includes('highest') || originalLower.includes('max')) {
            if (!sqlLower.includes('max(') && !sqlLower.includes('order by') && !sqlLower.includes('desc')) {
                issues.push('Original query asks for maximum but SQL does not include MAX() or ORDER BY DESC');
                suggestions.push('Add MAX() function or ORDER BY DESC with LIMIT');
                isValid = false;
            }
        }

        if (originalLower.includes('minimum') || originalLower.includes('lowest') || originalLower.includes('min')) {
            if (!sqlLower.includes('min(') && !sqlLower.includes('order by') && !sqlLower.includes('asc')) {
                issues.push('Original query asks for minimum but SQL does not include MIN() or ORDER BY ASC');
                suggestions.push('Add MIN() function or ORDER BY ASC with LIMIT');
                isValid = false;
            }
        }

        // 3. Check for filtering conditions mentioned in original query
        const conditions = extractConditionsFromQuery(originalQuery);
        for (const condition of conditions) {
            if (!sqlLower.includes('where') && condition.length > 0) {
                issues.push('Original query mentions conditions but SQL has no WHERE clause');
                suggestions.push('Add WHERE clause with appropriate filtering conditions');
                isValid = false;
                break;
            }
        }

        // 4. Check for time-based queries
        if (originalLower.match(/\b(last|recent|past|since|between|before|after|during|year|month|week|day|date)\b/)) {
            if (!sqlLower.match(/\b(date|time|created|updated|year|month|day)\b/) && !sqlLower.includes('where')) {
                issues.push('Original query has time-based requirements but SQL may not include proper date filtering');
                suggestions.push('Add date/time filtering in WHERE clause');
                isValid = false;
            }
        }

        // 5. Check for grouping requirements
        if (originalLower.match(/\b(by|per|each|every|group|category|type)\b/) && !originalLower.includes('order by')) {
            if (!sqlLower.includes('group by')) {
                issues.push('Original query suggests grouping but SQL does not include GROUP BY');
                suggestions.push('Add GROUP BY clause to group results appropriately');
                isValid = false;
            }
        }

        // 6. Check for sorting requirements
        if (originalLower.match(/\b(sort|order|arrange|rank|top|bottom|first|last)\b/)) {
            if (!sqlLower.includes('order by')) {
                issues.push('Original query mentions ordering but SQL does not include ORDER BY');
                suggestions.push('Add ORDER BY clause to sort results');
                isValid = false;
            }
        }

        // 7. Validate that SQL is actually selecting relevant data
        if (!sqlLower.includes('select')) {
            issues.push('Generated SQL does not contain SELECT statement');
            isValid = false;
        }

        if (!sqlLower.includes('from')) {
            issues.push('Generated SQL does not contain FROM clause');
            isValid = false;
        }

        console.log(`✅ SQL validation completed. Valid: ${isValid}, Issues: ${issues.length}`);

    } catch (validationError) {
        console.error('❌ Error during SQL validation:', validationError);
        issues.push('Validation process encountered an error');
        isValid = false;
    }

    return {
        isValid,
        issues,
        suggestions
    };
}

/**
 * Attempts to correct the SQL query based on validation issues
 */
export async function correctSQLQuery(
    originalSQL: string,
    originalQuery: string,
    issues: string[],
    langchainApp: MedicalDatabaseLangChainApp,
    organizationId: string
): Promise<string | null> {
    try {
        console.log('🔧 Attempting to correct SQL query...');

        const sqlAgent = langchainApp.getSqlAgent();
        if (!sqlAgent) {
            console.log('❌ SQL Agent not available for correction');
            return null;
        }

        // Create a correction prompt that includes the original query, generated SQL, and identified issues
        const correctionPrompt = `
CRITICAL SQL CORRECTION NEEDED

Original User Query: "${originalQuery}"

Generated SQL: 
${originalSQL}

Identified Issues:
${issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')}

TASK: Generate a corrected SQL query that:
1. Addresses ALL the identified issues above
2. Fully satisfies the original user query requirements
3. Uses proper SQL syntax and structure
4. Includes all necessary JOINs, WHERE clauses, GROUP BY, ORDER BY as needed
5. Uses the correct database schema (explore schema if needed)

CRITICAL REQUIREMENTS:
- The corrected SQL must address EVERY issue listed above
- Include ALL conditions and requirements from the original query
- Use proper aggregation functions (COUNT, AVG, MAX, MIN) if mentioned in original query
- Add proper filtering with WHERE clause if conditions are mentioned
- Add GROUP BY if grouping is implied in the original query
- Add ORDER BY if sorting is mentioned in the original query
- Ensure all medical terms and concepts from original query are properly addressed

Generate ONLY the corrected SQL query without explanations.
`;

        console.log('📝 Sending correction prompt to SQL agent...');

        const correctionResult = await sqlAgent.call({
            input: correctionPrompt
        });

        if (correctionResult && correctionResult.output) {
            const correctedSQL = cleanSQLQuery(correctionResult.output);

            if (correctedSQL && correctedSQL !== originalSQL) {
                console.log('✅ SQL correction successful');
                console.log('🔧 Corrected SQL:', correctedSQL);
                return correctedSQL;
            }
        }

        console.log('⚠️ SQL correction did not produce a different query');
        return null;

    } catch (correctionError) {
        console.error('❌ Error during SQL correction:', correctionError);
        return null;
    }
}

/**
 * Helper function to check if a medical term is referenced in the SQL through related tables/columns
 */
export async function checkForRelatedTerm(
    term: string,
    sql: string,
    langchainApp: MedicalDatabaseLangChainApp,
    organizationId: string
): Promise<boolean> {
    try {
        // Simple check - see if there are related medical table names in the SQL
        const medicalTableKeywords = [
            'patient', 'diagnosis', 'medication', 'treatment', 'procedure',
            'test', 'result', 'lab', 'clinical', 'medical', 'pgx', 'genetic',
            'drug', 'dose', 'allergy', 'adverse', 'symptom', 'condition'
        ];

        const sqlLower = sql.toLowerCase();
        const termLower = term.toLowerCase();

        // Check if the term is part of a table or column name
        for (const keyword of medicalTableKeywords) {
            if (termLower.includes(keyword) && sqlLower.includes(keyword)) {
                return true;
            }
        }

        // Check if there are medical-related table names in the SQL
        if (sqlLower.match(/\b(patient|diagnosis|medication|treatment|procedure|test|result|lab|clinical|medical|pgx|genetic)\w*\b/)) {
            return true;
        }

        return false;
    } catch (error) {
        console.error('Error checking for related term:', error);
        return false;
    }
}

/**
 * Extracts conditions and filtering requirements from the original query
 */
export function extractConditionsFromQuery(query: string): string[] {
    const conditions: string[] = [];
    const queryLower = query.toLowerCase();

    // Look for common condition patterns
    const conditionPatterns = [
        /with\s+([^,\s]+)/g,
        /where\s+([^,\s]+)/g,
        /having\s+([^,\s]+)/g,
        /age\s*(>|<|=|>=|<=)\s*(\d+)/g,
        /older\s+than\s+(\d+)/g,
        /younger\s+than\s+(\d+)/g,
        /between\s+(\d+)\s+and\s+(\d+)/g,
        /in\s+the\s+last\s+(\d+)\s+(day|week|month|year)s?/g,
        /since\s+(\d{4})/g,
        /before\s+(\d{4})/g,
        /after\s+(\d{4})/g
    ];

    for (const pattern of conditionPatterns) {
        const matches = queryLower.matchAll(pattern);
        for (const match of matches) {
            conditions.push(match[0]);
        }
    }

    return conditions;
}
