export const SHOT_SIZES = [
  "extreme_wide",
  "wide",
  "medium_wide",
  "medium",
  "medium_close",
  "close_up",
  "extreme_close_up",
  "over_shoulder",
  "insert",
  "establishing",
] as const;

export const CAMERA_MOVEMENTS = [
  "static",
  "pan_left",
  "pan_right",
  "tilt_up",
  "tilt_down",
  "dolly_in",
  "dolly_out",
  "tracking_left",
  "tracking_right",
  "crane_up",
  "crane_down",
  "handheld",
  "steadicam",
  "whip_pan",
  "orbital",
  "zoom_in",
  "zoom_out",
  "rack_focus",
] as const;

export const LENS_VALUES = [14, 24, 35, 50, 85, 135, 200] as const;

export const LIGHTING_KEYS = [
  "high_key",
  "low_key",
  "natural",
  "golden_hour",
  "blue_hour",
  "tungsten_warm",
  "neon",
  "silhouette",
  "rim_lit",
  "volumetric",
  "overcast_soft",
] as const;

export const DEPTH_VALUES = ["shallow", "medium", "deep"] as const;
export const COLOR_TEMPERATURES = ["cool", "neutral", "warm", "mixed"] as const;
