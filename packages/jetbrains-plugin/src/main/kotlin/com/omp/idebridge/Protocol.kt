package com.omp.idebridge

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Wire types and JSON-RPC 2.0 plumbing for OMP IDE Bridge protocol v1.
 * See docs/protocol.md §3 (data types) and §4/§5 (methods/notifications).
 *
 * JSON is hand-rolled on top of Gson, which is bundled with the IntelliJ Platform
 * (lib/gson.jar) and therefore always on the plugin classpath.
 */

// ---- Data types (protocol.md §3) ----

data class Position(val line: Int, val character: Int)

data class Range(val start: Position, val end: Position)

data class Selection(val uri: String, val start: Position, val end: Position, val text: String)

data class Editor(val uri: String, val isActive: Boolean)

/** Present for protocol completeness; the `diagnostics` capability is NOT implemented in v1. */
data class Diagnostic(
    val uri: String,
    val range: Range,
    val severity: String,
    val message: String,
    val source: String?,
)

// ---- JSON-RPC 2.0 ----

object ErrorCodes {
    const val PARSE_ERROR = -32700
    const val INVALID_REQUEST = -32600
    const val METHOD_NOT_FOUND = -32601
    const val INVALID_PARAMS = -32602
    const val INTERNAL_ERROR = -32603
}

class RpcException(val code: Int, message: String) : Exception(message) {
    companion object {
        fun invalidParams(detail: String) = RpcException(ErrorCodes.INVALID_PARAMS, detail)
        fun methodNotFound(method: String) = RpcException(ErrorCodes.METHOD_NOT_FOUND, "Method not found: $method")
    }
}

object JsonRpc {
    private val gson = Gson()

    fun toJsonTree(value: Any): JsonElement = gson.toJsonTree(value)

    /** @throws RpcException PARSE_ERROR / INVALID_REQUEST */
    fun parse(text: String): JsonObject {
        val el: JsonElement = try {
            JsonParser.parseString(text)
        } catch (e: Exception) {
            throw RpcException(ErrorCodes.PARSE_ERROR, "Parse error")
        }
        if (!el.isJsonObject) throw RpcException(ErrorCodes.INVALID_REQUEST, "Request is not a JSON object")
        return el.asJsonObject
    }

    fun result(id: JsonElement, result: JsonElement): String = JsonObject().apply {
        addProperty("jsonrpc", "2.0")
        add("id", id)
        add("result", result)
    }.toString()

    fun error(id: JsonElement?, code: Int, message: String): String = JsonObject().apply {
        addProperty("jsonrpc", "2.0")
        add("id", id ?: JsonNull.INSTANCE)
        add("error", JsonObject().apply {
            addProperty("code", code)
            addProperty("message", message)
        })
    }.toString()

    fun notification(method: String, params: JsonElement): String = JsonObject().apply {
        addProperty("jsonrpc", "2.0")
        addProperty("method", method)
        add("params", params)
    }.toString()
}

// ---- Small helpers shared by the dispatch table ----

/** `{ "selection": <Selection|null> }` — result shape of getCurrentSelection / getLatestSelection. */
fun selectionResult(selection: Selection?): JsonObject = JsonObject().apply {
    add("selection", selection?.let(JsonRpc::toJsonTree) ?: JsonNull.INSTANCE)
}

/** @throws RpcException INVALID_PARAMS when absent or not a string. */
fun JsonObject?.requireString(name: String): String {
    val el = this?.get(name) ?: throw RpcException.invalidParams("Missing param '$name'")
    if (!el.isJsonPrimitive || !el.asJsonPrimitive.isString) {
        throw RpcException.invalidParams("Param '$name' must be a string")
    }
    return el.asString
}

/** @throws RpcException INVALID_PARAMS when present but not a non-negative integer. */
fun JsonObject?.optNonNegativeInt(name: String): Int? {
    val el = this?.get(name) ?: return null
    if (el.isJsonNull) return null
    if (!el.isJsonPrimitive || !el.asJsonPrimitive.isNumber) {
        throw RpcException.invalidParams("Param '$name' must be a non-negative integer")
    }
    val value = try {
        el.asInt
    } catch (e: Exception) {
        throw RpcException.invalidParams("Param '$name' must be a non-negative integer")
    }
    if (value < 0) throw RpcException.invalidParams("Param '$name' must be a non-negative integer")
    return value
}
