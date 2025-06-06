function createRevertMessageDueToMissingRole(address: string, role: string) {
  return `AccessControl: account ${address.toLowerCase()} is missing role ${role.toLowerCase()}`;
}

export { createRevertMessageDueToMissingRole };
