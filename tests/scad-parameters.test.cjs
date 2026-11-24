'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseScadParameters, suggestPartSelector, validateScadOverrides, scadDefineArgs } = require('../electron/scad-parameters.cjs');

test('public literal header preserves groups, descriptions and supported value types', () => {
  const result = parseScadParameters(`
/* [Dimensions] */
// Outside width
// Measured before the chamfer
outer_width = 24.5; // [10:0.5:100]
enabled = true;
caption = "sample";
offset = [1, -2, .3, 4e-1]; // [-10:0.1:10]
module body() { local_size = 900; }
not_public = 100;
`);
  assert.deepEqual(result.map((p) => [p.name, p.type, p.defaultValue]), [
    ['outer_width', 'number', 24.5], ['enabled', 'boolean', true],
    ['caption', 'string', 'sample'], ['offset', 'vector', [1,-2,0.3,0.4]],
  ]);
  assert.equal(result[0].label, 'outer width');
  assert.equal(result[0].description, 'Outside width\nMeasured before the chamfer');
  assert.equal(result[0].group, 'Dimensions');
  assert.deepEqual([result[0].min,result[0].max,result[0].step], [10,100,0.5]);
  assert.deepEqual([result[3].min,result[3].max,result[3].step], [-10,10,0.1]);
});

test('Hidden sections, special variables and non-literal expressions do not become overrides', () => {
  const result = parseScadParameters(`
size = 20;
$fn = 64;
computed = 1 + 2;
calculated_vector = [1, 2 + 3];
dependent = size;
text_function = str("a", "b");
missing = undef;
/* [Hidden] */
internal = 500;
size = 30;
/* [Global] */
public_flag = false;
/* [hidden] */
case_sensitive = 2;
`);
  assert.deepEqual(result.map((p) => p.name), ['public_flag','case_sensitive']);
  assert.equal(result[0].group, 'Global');
});

test('comments and quoted strings cannot create fake parameters or scope boundaries', () => {
  const result = parseScadParameters(String.raw`
// module fake() { hidden = 1; }
/* function fake() = 1; { hidden = 2; } */
caption = "module() { x = 5; } // /* text */";
escaped = "quote: \" slash: \\ line:\n tab:\t";
width = /* ignored inline */ 12;
union() { local = 9; }
after_geometry = 10;
`);
  assert.deepEqual(result.map((p) => p.name), ['caption','escaped','width']);
  assert.equal(result[1].defaultValue, 'quote: " slash: \\ line:\n tab:\t');
  assert.equal(result[2].defaultValue, 12);
});

test('module and function declarations conservatively end the public header, including inline bodies', () => {
  for (const boundary of ['module sample() {}', 'module sample() echo(1);', 'function sample(x) = x + 1;', 'translate([0,0,1]) { cube(1); }']) {
    assert.deepEqual(parseScadParameters(`before = 1; ${boundary} after = 2;`).map((p) => p.name), ['before']);
  }
});

test('include and use directives are skipped without reading external definitions', () => {
  const result = parseScadParameters('include <synthetic-library.scad>\nuse <synthetic-shapes.scad>;\npart = "body"; // [body:Body, cap:Cap]\n');
  assert.deepEqual(result.map((p) => p.name), ['part']);
  assert.equal(result[0].options.length, 2);
});

test('model-defined enum values and labels remain literal, including punctuation', () => {
  const result = parseScadParameters(`
part = "body"; // [body:Main body, cap:Top cap]
detail = 10; // [10:Coarse, 20:Medium, 30:Fine]
caption = "comma,value"; // ["comma,value":"label: first", "quote\\\"value":Second]
range_a = 5; // [50]
range_b = 5; // [-10:100]
`);
  assert.deepEqual(result[0].options, [{value:'body',label:'Main body'},{value:'cap',label:'Top cap'}]);
  assert.deepEqual(result[1].options, [{value:10,label:'Coarse'},{value:20,label:'Medium'},{value:30,label:'Fine'}]);
  assert.deepEqual(result[2].options, [{value:'comma,value',label:'label: first'},{value:'quote"value',label:'Second'}]);
  assert.deepEqual([result[3].min,result[3].max], [0,50]);
  assert.deepEqual([result[4].min,result[4].max], [-10,100]);
});

test('annotations are trailing same-line metadata and descriptions do not leak between declarations', () => {
  const result = parseScadParameters('// First description\na=1; // [0:10]\nb=2;\n// Next description\nc=3;\nd=4;\n// [1,2]\n');
  assert.equal(result[0].description, 'First description');
  assert.equal(result[1].description, '');
  assert.equal(result[2].description, 'Next description');
  assert.equal(result[3].options, undefined);
});

test('last public assignment wins while a later unsupported assignment removes the candidate', () => {
  const result = parseScadParameters('size=1; size=2; other=3; other=size*2;');
  assert.deepEqual(result.map((p) => [p.name,p.defaultValue]), [['size',2]]);
});

test('malformed defaults and annotations are never evaluated', () => {
  assert.deepEqual(parseScadParameters('number = 1e; list = [1,]; expression = import("synthetic.stl");'), []);
  const result = parseScadParameters('safe = 1; // [0:0:10]\ntext="a"; // ["broken"quote":Label]\n');
  assert.equal(result[0].step, undefined);
  assert.equal(result[1].options, undefined);
});

test('part selector suggestions use only explicit enum parameters, not module names or arbitrary strings', () => {
  const parameters = parseScadParameters('quality=1; // [1,2]\noutput="all"; // [all,base]\npart_selector="body"; // [body,cap]\nmodule cap() {}');
  assert.equal(suggestPartSelector(parameters), 'part_selector');
  assert.equal(suggestPartSelector(parseScadParameters('part="body"; module cap() {}')), null);
  assert.equal(suggestPartSelector(parseScadParameters('quality=1; // [1,2]')), null);
});

test('validation accepts only public typed values, declared enum values, ranges and steps', () => {
  const parameters = parseScadParameters('part="body"; // [body,cap]\nwidth=2; // [0:0.5:10]\nflag=true;\nvector=[1,2,3];\n');
  assert.deepEqual(validateScadOverrides(parameters, { part:'cap',width:2.5,flag:false,vector:[4,5,6] }), {part:'cap',width:2.5,flag:false,vector:[4,5,6]});
  for (const overrides of [{private:1}, {part:'other'}, {width:'2'}, {width:11}, {width:2.25}, {flag:1}, {vector:[1,2]}, {vector:[1,2,'3']}, {width:Infinity}, {width:NaN}]) assert.throws(() => validateScadOverrides(parameters, overrides));
  assert.deepEqual(validateScadOverrides(parameters, {}), {});
});

test('literal defaults remain usable when author slider steps do not align with them', () => {
  const parameters = parseScadParameters('number=2; // [0:5:100]\nvector=[12,34,46]; // [1:2:50]\n');
  assert.deepEqual(validateScadOverrides(parameters, {number:2,vector:[13,34,46]}), {number:2,vector:[13,34,46]});
});

test('override validation blocks prototype keys, inherited values and accessors without invoking them', () => {
  const parameters = parseScadParameters('flag=true;');
  let reads = 0;
  const getter = Object.defineProperty({}, 'flag', { enumerable: true, get() { reads++; return true; } });
  for (const overrides of [JSON.parse('{"__proto__":1}'), {constructor:1}, Object.create({flag:true}), getter, [], null]) assert.throws(() => validateScadOverrides(parameters, overrides));
  assert.equal(reads, 0);
  const array = [1];
  Object.defineProperty(array, '0', { get() { reads++; return 1; } });
  assert.throws(() => scadDefineArgs({vector:array}));
  assert.equal(reads, 0);
});

test('define serialization keeps strings quoted and produces argument arrays without shell evaluation', () => {
  const value = '"; include <synthetic.scad>; // \\ \n\r\t';
  const args = scadDefineArgs({ text:value, flag:false, count:-2.5, vector:[1,-2,0.25] });
  assert.deepEqual(args.slice(0,4), ['-D','count=-2.5','-D','flag=false']);
  assert.equal(args.length, 8);
  for (let i=0; i<args.length; i+=2) assert.equal(args[i], '-D');
  const roundtrip = parseScadParameters(args.filter((_,i) => i % 2 === 1).map((arg) => arg+';').join('\n'));
  assert.equal(roundtrip.find((p) => p.name === 'text').defaultValue, value);
  assert.deepEqual(roundtrip.find((p) => p.name === 'vector').defaultValue, [1,-2,0.25]);
  for (const overrides of [{ 'part;cube(1)':1 }, { '$fn':10 }, { bad:undefined }, { bad:()=>1 }, { bad:'\0' }, { bad:[[1,2]] }]) assert.throws(() => scadDefineArgs(overrides));
});

test('source, parameter, string, vector and command-length limits are enforced', () => {
  assert.throws(() => parseScadParameters(' '.repeat(4 * 1024 * 1024 + 1)), /文字数上限/);
  assert.throws(() => parseScadParameters(Array.from({length:257},(_,i)=>`p${i}=1;`).join('\n')), /256/);
  assert.throws(() => scadDefineArgs({text:'a'.repeat(4097)}));
  assert.throws(() => scadDefineArgs({vector:Array(65).fill(1)}));
  assert.throws(() => scadDefineArgs({a:'a'.repeat(4096),b:'b'.repeat(4096)}), /コマンド長/);
  assert.throws(() => scadDefineArgs({number:1e13}));
});
