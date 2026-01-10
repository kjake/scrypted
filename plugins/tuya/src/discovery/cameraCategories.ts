export const DEFAULT_CAMERA_CATEGORIES = [
  "sp",
  "wf_sp",
  "wf_sub_sp",
  "cdsxj",
  "sxj4g",
  "dghsxj",
  "bjsxj",
  "ksdjsxj",
  "znwnsxj",
  "sp_wnq",
  "ksdjml",
  "dmsxj",
  "sp_Gsmart",
  "xcjly",
  "ipcsxj1",
  "cwsxj",
  "dpsxj",
  "ipcsxj2",
  "ydsxj",
  "mobilecam",
  "acc_ctrl_cam",
  "trailcam",
  "one_stop_solution_cam",
  "pettv",
];

export function isCameraCategory(category: string, extras: string[] = []): boolean {
  const allow = new Set<string>([...DEFAULT_CAMERA_CATEGORIES, ...extras]);
  if (allow.has(category)) return true;
  const lowered = category.toLowerCase();
  return lowered.includes("sxj") || lowered.includes("sp") || lowered.includes("cam");
}
