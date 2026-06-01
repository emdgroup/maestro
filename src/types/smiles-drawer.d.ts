declare module "smiles-drawer" {
  interface SvgDrawerOptions {
    width?: number;
    height?: number;
    bondThickness?: number;
    bondLength?: number;
    bondSpacing?: number;
    padding?: number;
    fontFamily?: string;
    fontSizeLarge?: number;
    fontSizeSmall?: number;
    compactDrawing?: boolean;
    isomeric?: boolean;
    terminalCarbons?: boolean;
    explicitHydrogens?: boolean;
    debug?: boolean;
    themes?: Record<string, Record<string, string>>;
  }

  class SvgDrawer {
    constructor(options?: SvgDrawerOptions, clear?: boolean);
    draw(
      data: unknown,
      target: string | SVGElement,
      themeName?: "light" | "dark",
      weights?: unknown,
      infoOnly?: boolean,
    ): void;
  }

  interface SmilesDrawerNamespace {
    SvgDrawer: typeof SvgDrawer;
    parse(
      smiles: string,
      successCallback: (tree: unknown) => void,
      errorCallback?: (err: unknown) => void,
    ): void;
  }

  const _default: SmilesDrawerNamespace;
  export default _default;
}
