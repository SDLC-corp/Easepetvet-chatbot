// Cleans extracted raw text into readable plain text. Pure function.
// Normalizes line endings and spaces, trims lines, drops empty lines, and
// collapses runs of blank lines to a single blank line.

export function cleanText(rawText) {
  if (!rawText) return '';

  const normalized = rawText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/ /g, ' ')
    .replace(/&nbsp;/gi, ' ')
    // Add a space when a sentence ends and the next starts with no space
    // ("it.You'll" -> "it. You'll"). Requires lowercase-before-period so it
    // won't split "EasePetVet" or initials.
    .replace(/([a-z])([.!?])([A-Z])/g, '$1$2 $3');

  const lines = normalized
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim());

  const cleaned = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.length === 0) {
      blankRun += 1;
      if (blankRun <= 1) cleaned.push('');
    } else {
      blankRun = 0;
      cleaned.push(line);
    }
  }

  return cleaned.join('\n').trim();
}
