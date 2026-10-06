//! The existing TypeScript sfc32 stream, including UTF-16 string hashing and forks.
pub(crate) struct Rng {
    key: String,
    state: [u32; 4],
}

impl Rng {
    pub fn new(seed: &str) -> Self {
        let [mut h1, mut h2, mut h3, mut h4]: [u32; 4] =
            [1779033703, 3144134277, 1013904242, 2773480762];
        for k in seed.encode_utf16().map(u32::from) {
            h1 = h2 ^ (h1 ^ k).wrapping_mul(597399067);
            h2 = h3 ^ (h2 ^ k).wrapping_mul(2869860233);
            h3 = h4 ^ (h3 ^ k).wrapping_mul(951274213);
            h4 = h1 ^ (h4 ^ k).wrapping_mul(2716044179);
        }
        h1 = (h3 ^ (h1 >> 18)).wrapping_mul(597399067);
        h2 = (h4 ^ (h2 >> 22)).wrapping_mul(2869860233);
        h3 = (h1 ^ (h3 >> 17)).wrapping_mul(951274213);
        h4 = (h2 ^ (h4 >> 19)).wrapping_mul(2716044179);
        let mut rng = Self {
            key: seed.into(),
            state: [h1 ^ h2 ^ h3 ^ h4, h2 ^ h1, h3 ^ h1, h4 ^ h1],
        };
        for _ in 0..12 {
            rng.next();
        }
        rng
    }

    fn next(&mut self) -> u32 {
        let [a, b, c, d] = self.state;
        let t = a.wrapping_add(b).wrapping_add(d);
        self.state = [
            b ^ (b >> 9),
            c.wrapping_add(c << 3),
            c.rotate_left(21).wrapping_add(t),
            d.wrapping_add(1),
        ];
        t
    }

    pub fn fork(&self, label: &str) -> Self {
        Self::new(&format!("{}\u{1}{label}", self.key))
    }

    pub fn float(&mut self) -> f64 {
        self.next() as f64 / 4294967296.0
    }

    pub fn range(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.float()
    }
}
