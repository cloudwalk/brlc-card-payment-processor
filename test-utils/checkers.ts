import { expect } from "chai";

function checkEventField(fieldName: string, expectedValue: any): (value: any) => boolean {
  const f = function (value: any): boolean {
    expect(value).to.equal(
      expectedValue,
      `The "${fieldName}" field of the event is wrong`
    );
    return true;
  };
  Object.defineProperty(f, "name", { value: `checkEventField_${fieldName}`, writable: false });
  return f;
}

export {
  checkEventField,
};
