import { createContext, useContext } from 'react';

// Shares the active variable resolution map + a "set as variable" opener with
// every VarInput, so {{tokens}} can be previewed and selections promoted to
// variables anywhere (URL, params, headers, auth).
//
// Value shape:
//   {
//     lookup(name) -> { value, scope } | null,
//     onSetVariable(selectedText) -> void,
//   }
export const VarContext = createContext({
  lookup: () => null,
  onSetVariable: () => {},
});

export function useVarContext() {
  return useContext(VarContext);
}
