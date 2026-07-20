export function rawAnionGap(sodium: number, chloride: number, bicarbonate: number): number {
  return sodium - (chloride + bicarbonate);
}

export function albuminCorrectedAnionGap(gap: number, albumin: number): number {
  return gap + 2.5 * (4 - albumin);
}

export function deltaRatioApplicable(gap: number, bicarbonate: number): boolean {
  return gap > 12 && bicarbonate < 24;
}

export function deltaRatio(gap: number, bicarbonate: number): number {
  return (gap - 12) / (24 - bicarbonate);
}
