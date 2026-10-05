// A PNG imported from client code is a URL: Bun's HTML bundle hashes the file into a static route.
declare module "*.png" {
  const url: string;
  export default url;
}
