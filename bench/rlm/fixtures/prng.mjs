/** Seeded PRNG (mulberry32) with the helpers the fixture generators use. */
export function createRng(seed) {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const int = (min, max) => min + Math.floor(next() * (max - min + 1));
	const pick = (items) => items[Math.floor(next() * items.length)];
	const chance = (p) => next() < p;
	const shuffle = (items) => {
		const copy = [...items];
		for (let i = copy.length - 1; i > 0; i--) {
			const j = Math.floor(next() * (i + 1));
			[copy[i], copy[j]] = [copy[j], copy[i]];
		}
		return copy;
	};
	return { next, int, pick, chance, shuffle };
}
