declare module 'virtual:pages-build' {
  const value: {id: string; base: string; origin: string; publicIndexing: boolean; hasApk: boolean; pages: {path: string; title: string; kind: string; id?: string}[]};
  export default value;
}
declare module 'virtual:pages-layout-styles';
