import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export interface HandInput {
  position: string
  holeCards: string
  board: string
  actions: { street: string; action: string; amount?: number }[]
  potSize: number
  stackSize: number
}

export interface AnalysisResult {
  summary: string
  streetBreakdown: {
    street: string
    decision: string
    assessment: string
    evImpact: string
  }[]
  leaks: string[]
  score: number
  recommendation: string
}

export async function analyzeHand(hand: HandInput): Promise<AnalysisResult> {
  const actionsText = hand.actions
    .map(a => `${a.street}: ${a.action}${a.amount ? ` $${a.amount}` : ''}`)
    .join('\n')

  const prompt = `You are an expert poker coach specializing in GTO strategy. Analyze the hand below and respond with valid JSON only.

Hand:
- Position: ${hand.position}
- Hole cards: ${hand.holeCards}
- Board: ${hand.board || 'Preflop only'}
- Stack: $${hand.stackSize}
- Pot: $${hand.potSize}
- Actions:
${actionsText}

Return a JSON object with exactly this structure:
{
  "summary": "2-3 sentence overall assessment",
  "streetBreakdown": [
    {
      "street": "Preflop|Flop|Turn|River",
      "decision": "what the player did",
      "assessment": "good|questionable|mistake",
      "evImpact": "brief explanation of EV impact"
    }
  ],
  "leaks": ["list of leak category strings like 'Overfolding to 3-bets IP'"],
  "score": <integer 0-100>,
  "recommendation": "1-2 sentences on what to study"
}`

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  })

  const content = response.choices[0].message.content
  if (!content) throw new Error('Empty response from OpenAI')

  return JSON.parse(content) as AnalysisResult
}
