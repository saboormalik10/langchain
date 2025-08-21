import { DatabaseVersionInfo } from "../services/databaseVersionService";

/**
 * Generate version-specific database compatibility instructions
 * @param databaseType Database type (mysql, postgresql, etc.)
 * @param databaseVersionInfo Database version information
 * @returns Version-specific instructions string
 */
export function generateVersionSpecificInstructions(
    databaseType: string,
    databaseVersionInfo: DatabaseVersionInfo | null
): string {
    const versionSpecificInstructions = databaseVersionInfo ? `
${databaseType.toUpperCase()} VERSION INFO: Your query will run on ${databaseType.toUpperCase()} ${databaseVersionInfo.full} (${databaseVersionInfo.major}.${databaseVersionInfo.minor}.${databaseVersionInfo.patch})

VERSION-SPECIFIC COMPATIBILITY:
- JSON Functions (e.g., JSON_EXTRACT): ${databaseVersionInfo.supportsJSON ? 'AVAILABLE ✅' : 'NOT AVAILABLE ❌'}
- Window Functions (e.g., ROW_NUMBER()): ${databaseVersionInfo.supportsWindowFunctions ? 'AVAILABLE ✅' : 'NOT AVAILABLE ❌'}
- Common Table Expressions (WITH): ${databaseVersionInfo.supportsCTE ? 'AVAILABLE ✅' : 'NOT AVAILABLE ❌'}
- Regular Expressions: AVAILABLE ✅
${databaseType.toLowerCase() === 'mysql' ? `- MySQL only_full_group_by mode: ${databaseVersionInfo.hasOnlyFullGroupBy ? 'ENABLED 🚨 (STRICT GROUP BY REQUIRED)' : 'DISABLED ✅'}` : ''}

🚨 CRITICAL MySQL GROUP BY COMPLIANCE (sql_mode=only_full_group_by):
${databaseType.toLowerCase() === 'mysql' && databaseVersionInfo.hasOnlyFullGroupBy ? `
**🚨 ONLY_FULL_GROUP_BY MODE IS ENABLED - STRICT COMPLIANCE REQUIRED:**
1. **ALL non-aggregated columns in SELECT MUST be in GROUP BY clause**
2. **If using aggregation functions (COUNT, SUM, AVG, MAX, MIN), ALL other SELECT columns MUST be in GROUP BY**
3. **NEVER mix aggregated and non-aggregated columns without proper GROUP BY**

**CORRECT PATTERN:**
✅ SELECT column1, column2, COUNT(*) FROM table GROUP BY column1, column2;
✅ SELECT column1, AVG(column2) FROM table GROUP BY column1;
✅ SELECT * FROM table WHERE condition; (no aggregation)

**INCORRECT PATTERN (WILL FAIL):**
❌ SELECT column1, column2, COUNT(*) FROM table GROUP BY column1; (missing column2 in GROUP BY)
❌ SELECT column1, AVG(column2) FROM table; (missing GROUP BY when using aggregation)
❌ SELECT column1, column2, risk_score FROM table GROUP BY column1, column2, patient_id HAVING AVG(risk_score) > 2; (risk_score not aggregated but not in GROUP BY)

**FIX STRATEGY:**
- If using aggregation: Either aggregate ALL columns (COUNT, MAX, MIN, etc.) OR include them in GROUP BY
- If NOT using aggregation: Remove GROUP BY entirely
- Example fix: SELECT column1, column2, AVG(risk_score) FROM table GROUP BY column1, column2 HAVING AVG(risk_score) > 2;

**MYSQL sql_mode=only_full_group_by COMPLIANCE IS ABSOLUTELY MANDATORY**` : databaseType.toLowerCase() === 'mysql' ? '**MySQL GROUP BY COMPLIANCE**: Ensure proper GROUP BY usage for any aggregation queries' : ''}

CRITICAL: Use ONLY SQL features compatible with this ${databaseType.toUpperCase()} version. Avoid any syntax not supported by ${databaseVersionInfo.full}.
` : '';

    return versionSpecificInstructions;
}
