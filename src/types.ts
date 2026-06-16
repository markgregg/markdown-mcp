export type ComponentCategory =
  | "form"
  | "layout"
  | "input"
  | "display"
  | "navigation"
  | "other";

export interface ComponentProp {
  name: string;
  type: string;
  description: string;
}

export interface ComponentDefinition {
  name: string;
  description: string;
  props: ComponentProp[];
  category: ComponentCategory;
  example: string | null;
  filePath: string;
  tags: string[];
  version: string | null;
  author: string | null;
  deprecated: boolean;
  warnings: string[];
}
