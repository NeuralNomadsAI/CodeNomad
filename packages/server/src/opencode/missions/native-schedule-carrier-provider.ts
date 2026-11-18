/** Native AISDK resolves this owned file before the language hook. A missing
 * hook fails locally instead of selecting any user's provider. */
export const createNativeScheduleCarrierProvider = () => ({
  languageModel() { throw new Error("schedule-carrier-language-unavailable") },
})
