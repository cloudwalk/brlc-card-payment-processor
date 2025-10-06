import { expect } from "chai";

function checkEventField<T>(fieldName: string, expectedValue: T): (value: T) => boolean {
  const f = function (value: T): boolean {
    expect(value).to.equal(
      expectedValue,
      `The "${fieldName}" field of the event is wrong`,
    );
    return true;
  };
  Object.defineProperty(f, "name", { value: `checkEventField_${fieldName}`, writable: false });
  return f;
}

function checkEventFieldNotEqual<T>(fieldName: string, notExpectedValue: T): (value: T) => boolean {
  const f = function (value: T): boolean {
    expect(value).not.to.equal(
      notExpectedValue,
      `The "${fieldName}" field of the event is wrong because it is equal ${notExpectedValue} but should not`,
    );
    return true;
  };
  Object.defineProperty(f, "name", { value: `checkEventFieldNot_${fieldName}`, writable: false });
  return f;
}

function checkEquality<T extends Record<string, unknown>>(actualObject: T, expectedObject: T, index?: number) {
  const indexString = !index ? "" : ` with index: ${index}`;
  Object.keys(expectedObject).forEach((property) => {
    const value = actualObject[property];
    if (typeof value === "undefined" || typeof value === "function" || typeof value === "object") {
      throw Error(`Property "${property}" is not found in the actual object` + indexString);
    }
    expect(value).to.eq(
      expectedObject[property],
      `Mismatch in the "${property}" property between the actual object and expected one` + indexString,
    );
  });
}

export { checkEventField, checkEventFieldNotEqual, checkEquality };
