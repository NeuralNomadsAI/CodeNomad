const JSON_TYPES = new Set(["null", "array", "object", "integer", "number", "string", "boolean"])
const SCHEMA_KEYS = new Set([
  "type", "enum", "const", "minLength", "maxLength", "minimum", "maximum",
  "minItems", "maxItems", "items", "required", "properties", "additionalProperties",
  "allOf", "anyOf", "oneOf",
])
const SCHEMA_DEPTH_LIMIT = 20
const SCHEMA_NODE_LIMIT = 2_000

export interface JsonSchemaIssue {
  path: Array<string | number>
  message: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

const nonNegativeInteger = (value: unknown) => Number.isInteger(value) && (value as number) >= 0

const jsonEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => jsonEqual(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && jsonEqual(left[key], right[key]))
}

export function inspectJsonSchema(schema: Record<string, unknown>): JsonSchemaIssue[] {
  const issues: JsonSchemaIssue[] = []
  const pending: Array<{ schema: Record<string, unknown>; path: Array<string | number>; depth: number }> = [
    { schema, path: [], depth: 0 },
  ]
  let nodes = 0

  while (pending.length) {
    const current = pending.pop()!
    if (++nodes > SCHEMA_NODE_LIMIT) {
      issues.push({ path: current.path, message: "JSON schema has too many nested schemas" })
      break
    }
    if (current.depth > SCHEMA_DEPTH_LIMIT) {
      issues.push({ path: current.path, message: "JSON schema is too deeply nested" })
      continue
    }
    const add = (key: string, message: string) => issues.push({ path: [...current.path, key], message })

    for (const key of Object.keys(current.schema)) {
      if (!SCHEMA_KEYS.has(key)) add(key, `Unsupported JSON schema keyword: ${key}`)
    }

    if (current.schema.type !== undefined) {
      const types = typeof current.schema.type === "string" ? [current.schema.type] : current.schema.type
      if (!Array.isArray(types) || types.length === 0 || types.some((type) => typeof type !== "string" || !JSON_TYPES.has(type))) {
        add("type", "JSON schema type must contain only supported JSON types")
      } else if (new Set(types).size !== types.length) {
        add("type", "JSON schema types must be unique")
      }
    }
    if (current.schema.enum !== undefined) {
      if (!Array.isArray(current.schema.enum)) add("enum", "JSON schema enum must be an array")
      else if (current.schema.enum.length === 0) add("enum", "JSON schema enum must not be empty")
      else if (current.schema.enum.some((value, index, values) => values.slice(0, index).some((other) => jsonEqual(value, other)))) {
        add("enum", "JSON schema enum values must be unique")
      }
    }
    for (const key of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
      if (current.schema[key] !== undefined && !nonNegativeInteger(current.schema[key])) add(key, `${key} must be a non-negative integer`)
    }
    for (const key of ["minimum", "maximum"] as const) {
      if (current.schema[key] !== undefined && (typeof current.schema[key] !== "number" || !Number.isFinite(current.schema[key]))) {
        add(key, `${key} must be a finite number`)
      }
    }
    if (current.schema.required !== undefined) {
      const required = current.schema.required
      if (!Array.isArray(required) || required.some((key) => typeof key !== "string")) add("required", "required must be an array of property names")
      else if (new Set(required).size !== required.length) add("required", "required property names must be unique")
    }
    if (current.schema.additionalProperties !== undefined && typeof current.schema.additionalProperties !== "boolean") {
      add("additionalProperties", "additionalProperties must be a boolean")
    }

    const enqueue = (value: unknown, path: Array<string | number>) => {
      if (!isRecord(value)) {
        issues.push({ path, message: "Nested JSON schema must be an object" })
        return
      }
      pending.push({ schema: value, path, depth: current.depth + 1 })
    }
    if (current.schema.items !== undefined) enqueue(current.schema.items, [...current.path, "items"])
    if (current.schema.properties !== undefined) {
      if (!isRecord(current.schema.properties)) add("properties", "properties must be an object")
      else for (const [key, child] of Object.entries(current.schema.properties)) enqueue(child, [...current.path, "properties", key])
    }
    for (const key of ["allOf", "anyOf", "oneOf"] as const) {
      const alternatives = current.schema[key]
      if (alternatives === undefined) continue
      if (!Array.isArray(alternatives) || alternatives.length === 0) {
        add(key, `${key} must be a non-empty array of schemas`)
        continue
      }
      alternatives.forEach((child, index) => enqueue(child, [...current.path, key, index]))
    }
  }
  return issues
}

const typeMatches = (value: unknown, type: string) => {
  if (type === "null") return value === null
  if (type === "array") return Array.isArray(value)
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value)
  if (type === "integer") return Number.isInteger(value)
  if (type === "number") return typeof value === "number" && Number.isFinite(value)
  return typeof value === type
}

export function validateJsonSchemaValue(value: unknown, schema: Record<string, unknown>, path = "$"): string[] {
  const errors: string[] = []
  const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : []
  if (types.length && !types.some((type) => typeof type === "string" && typeMatches(value, type))) {
    return [`${path} must be ${types.join(" or ")}`]
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonEqual(candidate, value))) errors.push(`${path} is not an allowed value`)
  if (Object.prototype.hasOwnProperty.call(schema, "const") && !jsonEqual(schema.const, value)) errors.push(`${path} must equal const`)

  if (typeof value === "string") {
    const length = [...value].length
    if (typeof schema.minLength === "number" && length < schema.minLength) errors.push(`${path} is too short`)
    if (typeof schema.maxLength === "number" && length > schema.maxLength) errors.push(`${path} is too long`)
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path} is below minimum`)
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path} is above maximum`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path} has too few items`)
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path} has too many items`)
    if (isRecord(schema.items)) value.forEach((item, index) => errors.push(...validateJsonSchemaValue(item, schema.items as Record<string, unknown>, `${path}[${index}]`)))
  }
  if (isRecord(value)) {
    if (Array.isArray(schema.required)) for (const key of schema.required) {
      if (typeof key === "string" && !Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path}.${key} is required`)
    }
    const properties = isRecord(schema.properties) ? schema.properties : {}
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key) && isRecord(childSchema)) {
        errors.push(...validateJsonSchemaValue(value[key], childSchema, `${path}.${key}`))
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.prototype.hasOwnProperty.call(properties, key)) errors.push(`${path}.${key} is not allowed`)
    }
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    if (!Array.isArray(schema[keyword])) continue
    const results = schema[keyword].filter(isRecord).map((item) => validateJsonSchemaValue(value, item, path))
    const matches = results.filter((result) => result.length === 0).length
    if (keyword === "allOf" && matches !== results.length) errors.push(`${path} does not match allOf`)
    if (keyword === "anyOf" && matches === 0) errors.push(`${path} does not match anyOf`)
    if (keyword === "oneOf" && matches !== 1) errors.push(`${path} does not match exactly one oneOf schema`)
  }
  return errors
}
