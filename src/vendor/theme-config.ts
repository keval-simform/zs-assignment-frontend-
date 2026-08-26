/**
 * theme-config.ts — provided starter file. DO NOT MODIFY.
 * Tenant theme configs come from customers and cannot be trusted.
 */

export interface TenantTheme {
  appName: string;
  primary: string;    // hex color
  onPrimary: string; // hex color, used on top of primary
  background: string; // hex color
  surface: string;    // hex color (cards, group rows)
  text: string;       // hex color
  radius: number;     // px, 0-24
}

/** Per-field fallback values for invalid or missing config entries (see FR-8). */
export const DEFAULT_THEME: TenantTheme = {
  appName: "HCP Data Explorer",
  primary: "#0B5FA5",
  onPrimary: "#FFFFFF",
  background: "#FFFFFF",
  surface: "#F2F5F8",
  text: "#16202E",
  radius: 8,
};

export const TENANT_THEMES: Record<string, Partial<TenantTheme>> = {
  aurelia: {
    appName: "Aurelia Field IQ",
    primary: "#0B5FA5",
    onPrimary: "#FFFFFF",
    background: "#FFFFFF",
    surface: "#EFF5FA",
    text: "#152A3E",
    radius: 8,
  },
  meridian: {
    appName: "Meridian 360",
    primary: "#ZZ8800",
    background: "#FFFFFF",
    surface: "#F4F4F4",
    radius: "huge" as unknown as number,
  },
};
