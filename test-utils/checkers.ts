import { expect } from "chai";

function checkEventField<T>(fieldName: string, expectedValue: T): (value: T) => boolean {
  const f = function (value: T): boolean {
    expect(value).to.equal(
      expectedValue,
      `The "${fieldName}" field of the event is wrong`
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
      `The "${fieldName}" field of the event is wrong because it is equal ${notExpectedValue} but should not`
    );
    return true;
  };
  Object.defineProperty(f, "name", { value: `checkEventFieldNot_${fieldName}`, writable: false });
  return f;
}

export { checkEventField, checkEventFieldNotEqual };
