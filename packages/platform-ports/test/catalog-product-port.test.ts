import { describe } from "vitest";
import { createInMemoryCatalogProductStore } from "../src/catalog-product-port.js";
import { runCatalogProductPortContract } from "../contract/catalog-product-port.contract.js";

describe("in-memory CatalogProductPort", () => {
  runCatalogProductPortContract(async () => createInMemoryCatalogProductStore());
});
