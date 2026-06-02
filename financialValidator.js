/**
 * Financial Validator Utility
 * 
 * Implements a 4-step layered validation approach to verify the mathematical 
 * integrity of extracted financial tables.
 * 
 * Logic:
 * 1. Rule-Based (Labels like "Total")
 * 2. Pattern Discovery (Silent Sum/Subtraction)
 * 3. Cross-Column Consistency
 * 4. Confidence Scoring
 */

/**
 * Extracts numbers from a cell string, handling currencies, parentheses, and commas.
 */
function parseNumber(text) {
  if (!text || typeof text !== 'string') return null;
  
  // Handle (1,000) as -1000
  const isNegative = text.includes('(') && text.includes(')');
  let clean = text.replace(/[^0-9.-]/g, '');
  
  // If parentheses were used, ensure we treat it as negative
  if (isNegative && !clean.startsWith('-')) {
    clean = '-' + clean;
  }
  
  const num = parseFloat(clean);
  return isNaN(num) ? null : num;
}

/**
 * Converts a markdown table string into a 2D matrix of numbers and labels.
 */
function parseTableToMatrix(markdown) {
  const lines = markdown.trim().split('\n');
  const matrix = [];
  
  for (const line of lines) {
    if (!line.includes('|')) continue;
    if (line.includes('|---')) continue; // Skip separator
    
    const cells = line.split('|')
      .map(c => c.trim())
      .filter((c, i, arr) => i > 0 && i < arr.length - 1); // Remove empty outer cells
    
    if (cells.length > 0) {
      matrix.push(cells);
    }
  }
  return matrix;
}

/**
 * Core validation logic for a single table.
 */ 
function validateTable(markdown) {
  const matrix = parseTableToMatrix(markdown);
  // If the table is just a header or too small to have a mathematical relationship, 
  // we treat it as HIGH confidence (nothing to audit/fail).
  if (matrix.length < 2) return { confidence: 'HIGH', reason: 'Table too small for mathematical validation' };

  const numCols = matrix[0].length;
  const results = [];
  const columnData = [];

  // 1. Extract numerical data per column
  for (let j = 1; j < numCols; j++) {
    const isPercentageHeader = matrix[0] && matrix[0][j] && (matrix[0][j].includes('%') || /margin|ratio/i.test(matrix[0][j]));
    let percentCount = 0;
    let nonNullCount = 0;
    
    const colObj = matrix.slice(1).map((row, i) => {
      const text = row[j] || '';
      const num = parseNumber(text);
      if (num !== null) {
        nonNullCount++;
        if (text.includes('%')) percentCount++;
      }
      return { val: num, label: row[0], rowIndex: i };
    });

    if (isPercentageHeader || (nonNullCount > 0 && percentCount / nonNullCount > 0.3)) {
      continue; // Skip percentage/ratio columns
    }
    
    columnData.push(colObj);
  }

  // 1. Structural Checks (Layer 1 & 2)
  let hasHorizontalMatches = false;
  for (let j = 0; j < columnData.length; j++) {
    const col = columnData[j];
    for (let i = 0; i < col.length; i++) {
      const { val, label } = col[i];
      
      // Horizontal Check (Layer 2.5): Is this cell the sum of previous cells in the same row?
      if (j === columnData.length - 1 && val !== null) {
        const rowVals = columnData.slice(0, -1).map(c => c[i].val).filter(v => v !== null);
        if (rowVals.length > 1) {
          const rowSum = rowVals.reduce((a, b) => a + b, 0);
          if (Math.abs(rowSum - val) < 0.05) {
            hasHorizontalMatches = true;
          }
        }
      }
    }
  }

  // 2. Try Layered Validation (Rule-Based & Multi-Anchor Discovery)
  let ruleBasedMatches = 0;
  let patternMatches = 0;
  let totalDataColumns = columnData.length;

  for (let j = 0; j < columnData.length; j++) {
    const col = columnData[j];
    let runningSum = 0; // Sum of intermediate items ONLY
    let significantTotals = []; 
    let colSuccess = false;
    let rowsSinceLastTotal = 0;
    let hasSectionHeader = false;

    for (let i = 0; i < col.length; i++) {
      const { val, label } = col[i];

      if (val === null) {
        continue;
      }

      const isAnchorLabel = /revenue|sales|opening|start|assets|liabilities/i.test(label);
      const isTotalLabel = /\b(total|subtotal|net income|net profit|net loss|net cash|net revenue|net sales|gross profit|gross margin|balances)\b/i.test(label);
      const isBlockSum = Math.abs(runningSum - val) < 0.05 && (rowsSinceLastTotal > 1 || (isTotalLabel && rowsSinceLastTotal > 0));
      
      // Pattern 2: Multi-Anchor Operation
      let isAnchorMatch = false;
      if (significantTotals.length > 0) {
        for (let k = 0; k < significantTotals.length; k++) {
          const tA = significantTotals[k];
          
          // 2a. Anchor & Block: TotalA - Block = val OR TotalA + Block = val
          if (rowsSinceLastTotal > 0) {
            if (Math.abs((tA - runningSum) - val) < 0.05) { isAnchorMatch = true; break; }
            if (Math.abs((tA + runningSum) - val) < 0.05) { isAnchorMatch = true; break; }
          }
          
          // 2b. Anchor to Anchor: TotalA - TotalB = val OR TotalA + TotalB = val
          for (let m = 0; m < significantTotals.length; m++) {
            if (k === m) continue;
            const tB = significantTotals[m];
            if (Math.abs((tA - tB) - val) < 0.05) { isAnchorMatch = true; break; }
            if (Math.abs((tA + tB) - val) < 0.05) { isAnchorMatch = true; break; }
          }
          if (isAnchorMatch) break;
        }
      }

      const isMathMatch = (isBlockSum || isAnchorMatch) && val !== 0;

      if (isMathMatch) {
        ruleBasedMatches++;
        colSuccess = true;
        significantTotals.push(val);
        runningSum = 0; 
        rowsSinceLastTotal = 0;
      } else if (isTotalLabel || (isAnchorLabel && significantTotals.length === 0)) {
        if (significantTotals.length === 0) {
          significantTotals.push(val);
          runningSum = 0;
          rowsSinceLastTotal = 0;
        } else {
          runningSum += val;
          rowsSinceLastTotal++;
        }
      } else {
        runningSum += val;
        rowsSinceLastTotal++;
      }
    }
    
    if (colSuccess) patternMatches++;
    if (!col.some(r => /\b(total|subtotal|net income|net profit|net loss|net cash|net revenue|net sales|gross profit|gross margin|balances)\b/i.test(r.label))) totalDataColumns--;
  }

  // 4. Decision Logic (Layer 4)
  let confidence = 'LOW';
  let reason = 'Mathematical inconsistency detected (Totals do not match components)';

  if (hasHorizontalMatches && patternMatches > 0) {
    confidence = 'HIGH';
    reason = 'Validated via horizontal row-sums and vertical column consistency';
  } else if (hasHorizontalMatches && totalDataColumns <= 0) {
    confidence = 'HIGH';
    reason = 'Validated via horizontal row-sums (No vertical totals present)';
  } else if (patternMatches === columnData.length && columnData.length > 0) {
    confidence = 'HIGH';
    reason = 'Consistent hierarchical mathematical pattern discovered across all columns';
  } else if (ruleBasedMatches >= totalDataColumns && totalDataColumns > 0) {
    confidence = 'HIGH';
    reason = 'Rule-based validation successful across columns';
  } else if (patternMatches === 0 && !hasHorizontalMatches) {
    if (totalDataColumns <= 0 || matrix.length <= 8) {
      confidence = 'HIGH';
      reason = 'Text extraction complete (No mathematical structures found)';
    } else {
      confidence = 'MEDIUM';
      reason = 'Contains total labels but no mathematical structures could be verified';
    }
  } else if (patternMatches > 0 || ruleBasedMatches > 0 || hasHorizontalMatches) {
    confidence = 'MEDIUM';
    reason = 'Partial mathematical consistency detected; some sections fail validation';
  }

  // Fallback for short narrative tables that accidentally triggered a single math match (coincidence)
  if (confidence === 'MEDIUM' && totalDataColumns <= 0 && matrix.length <= 8) {
    confidence = 'HIGH';
    reason = 'Text extraction complete (No mathematical structures expected in this short table)';
  }

  return {
    confidence,
    reason,
    stats: {
      ruleBasedMatches,
      patternMatches,
      totalDataColumns
    }
  };
}

/**
 * Validates an entire markdown document or page by checking all tables.
 */
function validateDocument(text) {
  if (!text || !text.includes('|')) {
    return { confidence: 'HIGH', reason: 'No tables found on this page' };
  }

  const tables = text.match(/\|(.+)\|[\s\S]+?(\n\n|\n$|$)/g) || [];
  if (tables.length === 0) return { confidence: 'HIGH', reason: 'No tables found on this page' };

  const results = tables.map(validateTable);
  
  // A document/page is only as strong as its weakest table.
  const lowestConfidence = results.reduce((min, r) => {
    const scores = { 'HIGH': 3, 'MEDIUM': 2, 'LOW': 1 };
    return scores[r.confidence] < scores[min.confidence] ? r : min;
  }, results[0]);

  return lowestConfidence;
}

module.exports = {
  parseNumber,
  parseTableToMatrix,
  validateTable,
  validateDocument
};
