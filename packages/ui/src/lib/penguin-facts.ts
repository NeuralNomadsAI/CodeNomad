/**
 * 100 Penguin Facts for the thinking card.
 * Facts sourced from Audubon, WWF, National Geographic, Good Housekeeping, and other wildlife organizations.
 */

const PENGUIN_FACTS = [
  // Size & Species
  "Emperor penguins are the largest living penguin species, standing nearly 4 feet tall and weighing over 77 pounds.",
  "The Little Blue Penguin is the smallest species, measuring just 13-15 inches and weighing under 3 pounds.",
  "Scientists have identified between 17-20 penguin species, though the exact number is still debated.",
  "A prehistoric Colossus Penguin stood nearly 7 feet tall and lived about 37 million years ago.",
  "The extinct mega penguin Palaeeudyptes lived 37-40 million years ago and stood over 5 feet tall.",
  "Kumimanu biceae, an extinct penguin from 60 million years ago, weighed around 220 pounds.",
  "There are 18 recognized penguin species living today.",
  "King penguins are the second-largest penguin species after emperors.",
  "Rockhopper penguins got their name from their ability to hop over rocky terrain.",
  "Chinstrap penguins are named for the thin black line under their chin.",

  // Physical Adaptations
  "Emperor penguins have about 80 feathers per square inch—more than any other bird.",
  "Penguins have a supraorbital gland above their eyes that filters salt from seawater, letting them drink while swimming.",
  "Penguins sneeze to expel excess salt filtered from seawater by their specialized glands.",
  "The pupil of a king penguin's eye becomes square when constricted.",
  "Penguins don't have teeth—instead, backward-facing fleshy spines line their mouths to help swallow fish.",
  "Penguin bones are dense and solid, unlike other birds with hollow bones, which helps them dive deeper.",
  "Penguins spread waterproofing oil from their preen gland on their feathers for insulation.",
  "A penguin's black and white coloring provides camouflage—black backs blend with the ocean from above, white bellies match the surface from below.",
  "Penguin feathers trap an insulating layer of warmth rather than relying solely on blubber.",
  "Emperor penguins have feathered legs so their ankles don't get cold in -50°C temperatures.",

  // Swimming & Diving
  "Gentoo penguins are the fastest swimmers, reaching speeds up to 22 mph.",
  "Most penguin species swim at a leisurely 4-7 mph.",
  "Emperor penguins can dive to depths of over 1,850 feet.",
  "The longest recorded emperor penguin dive lasted nearly 32 minutes.",
  "Emperor penguins can hold their breath for up to 22 minutes underwater.",
  "Penguins' wings have evolved into flippers, making them excellent swimmers but unable to fly.",
  "Penguins jump before diving to release air bubbles, which reduces drag and can triple their swimming speed.",
  "Some smaller penguins can launch themselves 6-9 feet into the air when returning to shore.",
  "Penguins spend up to 80% of their lives at sea.",
  "A group of penguins swimming together is called a 'raft'.",

  // Breeding & Parenting
  "Male emperor penguins incubate eggs on their feet under a feathered 'brood pouch' for about 65-75 days.",
  "During egg incubation, male emperor penguins can fast for up to 4 months, losing nearly half their body weight.",
  "Female penguins prefer pudgier males who can fast longer while incubating eggs.",
  "King penguins have the longest breeding cycle of any penguin species, lasting 14-16 months.",
  "Gentoo, Magellanic, and Royal penguins mate for life.",
  "Adelie penguin females can locate their previous mates within minutes of arriving at breeding colonies.",
  "Penguin couples use distinct vocalizations to find each other among thousands of birds in a colony.",
  "Both penguin parents share responsibility for caring for their young.",
  "Most penguin chicks hatch in late December in the Southern Hemisphere.",
  "Penguin chicks are born with fluffy down feathers before developing weatherproof adult plumage.",

  // Colony Life
  "A group of penguins on land is called a 'waddle'.",
  "Penguin colonies are also called 'rookeries'.",
  "Colony huddles of 5,000+ penguins rotate positions so each takes a turn on the cold outside.",
  "Zavodovski Island hosts Earth's largest penguin colony with approximately 2 million chinstrap penguins.",
  "A 'super-colony' of 1.5 million Adelie penguins was discovered in 2018 in the Danger Islands.",
  "Scientists can locate penguin colonies from space by spotting guano (droppings) stains on the ice.",
  "66 penguin colonies have been identified using satellite imagery to spot guano stains.",
  "All but two penguin species breed in large colonies of several thousand birds.",
  "Yellow-eyed penguins are unusual—they live as isolated pairs rather than in colonies.",
  "Penguins are remarkably loyal to their nesting sites, often returning to where they were born.",

  // Diet & Hunting
  "Emperor penguins eat Antarctic silverfish, krill, squid, and other fish—about 2-3 kg daily.",
  "Medium-sized penguins eat approximately 1 kg of seafood daily in summer, but only a third of that in winter.",
  "Penguins hunt fish, squid, krill, and crabs depending on their species and location.",
  "Little Blue Penguins hunt small fish and squid close to shore.",
  "Adelie penguins primarily eat krill and small fish.",
  "King penguins dive to catch lanternfish and squid.",
  "Gentoo penguins have a varied diet including fish, squid, and crustaceans.",
  "Penguins swallow their prey whole, headfirst.",
  "Penguin chicks are fed regurgitated food by their parents.",
  "Some penguins can consume several pounds of food in a single day during peak feeding.",

  // Habitat & Distribution
  "Wild penguins are found almost exclusively in the Southern Hemisphere.",
  "The Galápagos penguin is the only penguin species found north of the equator.",
  "Emperor penguins are the only penguin species that breeds during the Antarctic winter.",
  "Penguins and polar bears never meet in the wild—penguins live in the south, polar bears in the north.",
  "African penguins live on the coast of South Africa and Namibia.",
  "Little Blue Penguins are found in New Zealand and Australia.",
  "Magellanic penguins are found along the coasts of Argentina and Chile.",
  "Some emperor penguin colonies have adapted to breeding on ice shelves when sea ice fails.",
  "Adelie penguins build nests from tiny pebbles left behind by receding glaciers.",
  "Little penguins dig burrows in sand dunes with tunnel passages leading to nest bowls.",

  // Cold Adaptation
  "Emperor penguins can survive temperatures as low as -50°C (-58°F).",
  "Emperor penguins endure wind speeds up to 200 km/hr (124 mph).",
  "Penguins have special fats in their feet that prevent them from freezing on ice.",
  "Emperor penguins have two layers of feathers plus a good reserve of fat for insulation.",
  "Penguins have proportionally smaller beaks and flippers to minimize heat loss.",
  "Huddling behavior helps penguins conserve body heat in extreme cold.",
  "The global emperor penguin breeding population is estimated at 265,500-278,500 pairs.",
  "Emperor penguins are the least common Antarctic penguin species.",
  "Some penguins can regulate blood flow to their extremities to conserve heat.",
  "Penguin eggs must be kept at around 38°C (100°F) to develop properly.",

  // Fun Trivia
  "A king penguin at Edinburgh Zoo was knighted by Norway's King in 2008—Sir Nils Olav holds the rank of Colonel-in-Chief.",
  "January 20th is Penguin Awareness Day.",
  "April 25th is World Penguin Day.",
  "African penguins are called 'jackass penguins' because they bray like donkeys.",
  "Macaroni penguins were named after 18th-century British dandies called 'macaronis' who wore flamboyant feathered hats.",
  "Adelie penguins are named after Adélie Land, which was named for French explorer Jules Dumont d'Urville's wife.",
  "Early explorers called penguins 'strange geese'.",
  "The Magellanic penguin was named after Ferdinand Magellan's circumnavigation voyage.",
  "Gentoo penguins have the most prominent tail of all penguin species.",
  "Wild penguins in Antarctica are curious about humans and will investigate stationary visitors.",
  "Penguins have excellent hearing and rely on distinct calls to identify their mates.",
  "The word 'penguin' may come from the Welsh 'pen gwyn' meaning 'white head'.",
  "Penguins can recognize their own reflection, suggesting self-awareness.",
  "Some penguins toboggan on their bellies across ice to travel faster.",
  "Penguins pant and ruffle their feathers to cool down when they get too warm.",
  "The oldest known penguin fossil is about 62 million years old.",
  "Penguins evolved from flying birds and their flippers still contain the same bones as bird wings.",
  "A penguin's resting heart rate is about 60-70 beats per minute but drops to 20 during deep dives.",
  "Penguins undergo a 'catastrophic molt' once a year, losing all feathers over 2-3 weeks.",
  "During molting, penguins cannot swim or eat and must fast until their new feathers grow in.",
] as const

/**
 * Get a random penguin fact.
 */
export function getRandomPenguinFact(): string {
  const index = Math.floor(Math.random() * PENGUIN_FACTS.length)
  return PENGUIN_FACTS[index]
}

export { PENGUIN_FACTS }
