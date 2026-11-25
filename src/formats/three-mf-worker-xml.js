import sax from 'sax';

class XmlElement {
  firstChild = null;
  lastChild = null;
  nextSibling = null;
  previousSibling = null;
  nodeType = 1;

  constructor(tag, parentNode) {
    this.localName = tag.local;
    this.parentNode = parentNode;
    this.tags = tag.attributes;
  }

  get attributes() { return Object.values(this.tags); }

  getAttribute(name) {
    return Object.hasOwn(this.tags, name) ? this.tags[name].value : '';
  }

  appendChild(child) {
    child.previousSibling = this.lastChild;
    if (this.lastChild) this.lastChild.nextSibling = child;
    else this.firstChild = child;
    this.lastChild = child;
  }

  removeChild(child) {
    if (child.previousSibling) child.previousSibling.nextSibling = child.nextSibling;
    else this.firstChild = child.nextSibling;
    if (child.nextSibling) child.nextSibling.previousSibling = child.previousSibling;
    else this.lastChild = child.previousSibling;
    child.parentNode = child.previousSibling = child.nextSibling = null;
  }
}

class TriangleStyle {
  constructor(pid, p1, p2, p3, paint) {
    Object.assign(this, { pid, p1, p2, p3, paint_color: paint });
  }

  getAttribute(name) { return this[name]; }
}

const value = (attributes, name) => Object.hasOwn(attributes, name) ? attributes[name].value : '';
const numericValue = (attributes, name) => {
  const text = value(attributes, name);
  return text === '' ? '' : Number(text);
};

/** Retain the resource tree and compact mesh rows rather than nodes for all vertices and triangles. */
export function parseWorkerXml(text) {
  const parser = sax.parser(true, { xmlns: true, strictEntities: true });
  const open = [];
  let root;

  parser.onopentag = (tag) => {
    if (tag.name === 'parsererror') throw new Error('Invalid XML');
    const parent = open.at(-1);
    const attributes = tag.attributes;
    if (parent === null) {
      open.push(null);
    } else if (parent?.pointRows && tag.local === 'vertex') {
      parent.pointRows.push(numericValue(attributes, 'x'), numericValue(attributes, 'y'), numericValue(attributes, 'z'));
      open.push(null);
    } else if (parent?.indexRows && tag.local === 'triangle') {
      const index = parent.indexRows.length / 3;
      parent.indexRows.push(numericValue(attributes, 'v1'), numericValue(attributes, 'v2'), numericValue(attributes, 'v3'));
      const pid = value(attributes, 'pid');
      const p1 = value(attributes, 'p1');
      const p2 = value(attributes, 'p2');
      const p3 = value(attributes, 'p3');
      const paint_color = value(attributes, 'paint_color');
      if (pid || p1 || p2 || p3 || paint_color) {
        parent.triangleStyles ??= new Map();
        parent.triangleStyles.set(index, new TriangleStyle(pid, p1, p2, p3, paint_color));
      }
      open.push(null);
    } else {
      const node = new XmlElement(tag, parent);
      if (tag.local === 'vertices' && parent?.localName === 'mesh') node.pointRows = [];
      if (tag.local === 'triangles' && parent?.localName === 'mesh') node.indexRows = [];
      if (parent) parent.appendChild(node);
      else {
        if (root) throw new Error('Invalid XML');
        root = node;
      }
      open.push(node);
    }
  };
  parser.onclosetag = () => open.pop();

  try {
    parser.write(text).close();
    return root;
  } catch {
    return undefined;
  }
}
