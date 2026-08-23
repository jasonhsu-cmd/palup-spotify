import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { merchantRulesContract } from "@palup/platform-ports/contract/merchant-rules";
import { InMemoryMerchantRulesStore } from "../src/rules.js";

// The SAME contract `PostgresMerchantRulesStore` (`@palup/state-postgres`, task 5) runs — proves
// behavior-equivalence between the two adapters, not just that this one happens to pass its own
// bespoke assertions.
merchantRulesContract(() => new InMemoryMerchantRulesStore(new InMemoryRuntimeStore()));
