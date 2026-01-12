/**
 * Fun loading verbs displayed while the assistant is thinking.
 * Randomly selected to add personality to the waiting experience.
 */

const LOADING_VERBS = [
  "Thinking",
  "Pondering",
  "Cogitating",
  "Ruminating",
  "Contemplating",
  "Deliberating",
  "Meditating",
  "Reflecting",
  "Musing",
  "Considering",
  "Processing",
  "Computing",
  "Analyzing",
  "Synthesizing",
  "Crafting",
  "Brewing",
  "Cooking",
  "Conjuring",
  "Manifesting",
  "Channeling",
  "Summoning",
  "Invoking",
  "Materializing",
  "Assembling",
  "Constructing",
  "Engineering",
  "Architecting",
  "Designing",
  "Formulating",
  "Devising",
  "Plotting",
  "Scheming",
  "Strategizing",
  "Orchestrating",
  "Choreographing",
  "Composing",
  "Weaving",
  "Spinning",
  "Churning",
  "Percolating",
  "Marinating",
  "Simmering",
  "Distilling",
  "Refining",
  "Polishing",
  "Calibrating",
  "Optimizing",
  "Tuning",
  "Harmonizing",
  "Vibing",
] as const

/**
 * Get a random loading verb.
 */
export function getRandomLoadingVerb(): string {
  const index = Math.floor(Math.random() * LOADING_VERBS.length)
  return LOADING_VERBS[index]
}

/**
 * Get a formatted loading message with a random verb.
 */
export function getLoadingMessage(): string {
  return `${getRandomLoadingVerb()}...`
}

export { LOADING_VERBS }
