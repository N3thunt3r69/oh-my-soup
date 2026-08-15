/**
 * Sliding highlight overlay composited onto welcome and setup brand art.
 */
export interface ShineConfig {
	/** Overall opacity of the shine overlay, in [0, 1]. */
	strength: number;
	/** Center of the shine band along the art diagonal, in [0, 1]. */
	pos: number;
}

/**
 * Integer RGB triple with channels in [0, 255].
 */
export interface RgbTriple {
	r: number;
	g: number;
	b: number;
}

/**
 * Options for one rendered frame of the soup pixel logo.
 */
export interface SoupLogoOptions {
	/** Integer pixel scale; 2 doubles every pixel for large splash scenes. */
	scale?: 1 | 2;
	/** Optional shine highlight swept diagonally across the bowl. */
	shine?: ShineConfig;
}
