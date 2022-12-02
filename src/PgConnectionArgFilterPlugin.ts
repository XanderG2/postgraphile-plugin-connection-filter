import {
  getInnerCodec,
  isEnumCodec,
  PgSelectStep,
  PgTypeCodec,
  TYPES,
} from "@dataplan/pg";
import { ConnectionStep, ExecutableStep } from "grafast";
import type {
  GraphQLInputFieldConfigMap,
  GraphQLInputType,
  GraphQLOutputType,
  GraphQLType,
} from "graphql";
import { GraphQLNamedType } from "graphql";
import { PgType } from "pg-introspection";
import { SQL } from "pg-sql2";
import { OperatorsCategory } from "./interfaces";

const { version } = require("../package.json");

type AnyCodec = PgTypeCodec<any, any, any, any>;

const isSuitableForFiltering = (codec: AnyCodec): boolean =>
  codec !== TYPES.void &&
  !codec.columns &&
  !codec.isAnonymous &&
  !codec.arrayOfCodec &&
  !codec.polymorphism &&
  (!codec.domainOfCodec || isSuitableForFiltering(codec.domainOfCodec));

export const PgConnectionArgFilterPlugin: GraphileConfig.Plugin = {
  name: "PgConnectionArgFilterPlugin",
  version,

  // after: ["PgTypesPlugin", "PgCodecsPlugin", "PgCodecs"],

  schema: {
    hooks: {
      build(build) {
        const {
          inflection,
          graphql: { isListType, getNamedType },
          options: {
            connectionFilterAllowedFieldTypes,
            connectionFilterArrays,
          },
        } = build;

        build.connectionFilterOperatorsDigest = (codec) => {
          if (!isSuitableForFiltering(codec)) {
            // Not a base, domain, enum, or range type? Skip.
            return null;
          }

          // Perform some checks on the simple type (after removing array/range/domain wrappers)
          const pgSimpleCodec = getInnerCodec(codec);
          if (!pgSimpleCodec) return null;
          if (
            pgSimpleCodec.polymorphism ||
            pgSimpleCodec.columns ||
            pgSimpleCodec.isAnonymous
          ) {
            // Haven't found an enum type or a non-array base type? Skip.
            return null;
          }
          if (pgSimpleCodec === TYPES.json) {
            // The PG `json` type has no valid operators.
            // Skip filter type creation to allow the proper
            // operators to be exposed for PG `jsonb` types.
            return null;
          }

          // TODO:v5: I'm unsure if this will work as before, e.g. it might not wrap with GraphQLList/GraphQLNonNull/etc
          // Establish field type and field input type
          const itemCodec = codec.arrayOfCodec ?? codec;
          const fieldTypeName = build.getGraphQLTypeNameByPgCodec!(
            itemCodec,
            "output"
          );
          if (!fieldTypeName) {
            return null;
          }
          const fieldTypeMeta = build.getTypeMetaByName(fieldTypeName);
          if (!fieldTypeMeta) {
            return null;
          }
          const fieldInputTypeName = build.getGraphQLTypeNameByPgCodec!(
            itemCodec,
            "input"
          );
          if (!fieldInputTypeName) return null;
          const fieldInputTypeMeta =
            build.getTypeMetaByName(fieldInputTypeName);
          if (!fieldInputTypeMeta) return null;

          // Avoid exposing filter operators on unrecognized types that PostGraphile handles as Strings
          const namedTypeName = fieldTypeName;
          const namedInputTypeName = fieldInputTypeName;
          const actualStringCodecs = [
            TYPES.bpchar,
            TYPES.char,
            TYPES.name,
            TYPES.text,
            TYPES.varchar,
            TYPES.citext,
          ];
          if (
            namedInputTypeName === "String" &&
            !actualStringCodecs.includes(pgSimpleCodec)
          ) {
            // Not a real string type? Skip.
            return null;
          }

          // Respect `connectionFilterAllowedFieldTypes` config option
          if (
            connectionFilterAllowedFieldTypes &&
            !connectionFilterAllowedFieldTypes.includes(namedTypeName)
          ) {
            return null;
          }

          const pgConnectionFilterOperatorsCategory: OperatorsCategory =
            codec.arrayOfCodec
              ? "Array"
              : codec.rangeOfCodec
              ? "Range"
              : isEnumCodec(codec)
              ? "Enum"
              : codec.domainOfCodec
              ? "Domain"
              : "Scalar";

          // Respect `connectionFilterArrays` config option
          if (
            pgConnectionFilterOperatorsCategory === "Array" &&
            !connectionFilterArrays
          ) {
            return null;
          }

          const rangeElementInputTypeName = codec.rangeOfCodec
            ? build.getGraphQLTypeNameByPgCodec!(codec.rangeOfCodec, "input")
            : null;

          const domainBaseTypeName = codec.domainOfCodec
            ? build.getGraphQLTypeNameByPgCodec!(codec.domainOfCodec, "output")
            : null;

          const listType = !!(
            codec.arrayOfCodec || codec.rangeOfCodec?.arrayOfCodec
          );

          const operatorsTypeName = listType
            ? inflection.filterFieldListType(namedTypeName)
            : inflection.filterFieldType(namedTypeName);

          return {
            isList: listType,
            operatorsTypeName,
            relatedTypeName: namedTypeName,
            inputTypeName: fieldInputTypeName,
            rangeElementInputTypeName,
            domainBaseTypeName,
          };
        };

        build.escapeLikeWildcards = (input) => {
          if ("string" !== typeof input) {
            throw new Error(
              "Non-string input was provided to escapeLikeWildcards"
            );
          } else {
            return input.split("%").join("\\%").split("_").join("\\_");
          }
        };

        return build;
      },

      init: {
        after: ["PgCodecs"],
        callback(_, build) {
          const {
            inflection,
            graphql: { getNamedType, GraphQLString, isListType },
            options: {
              connectionFilterAllowedFieldTypes,
              connectionFilterArrays,
            },
          } = build;

          const codecs = new Set<AnyCodec>();

          // Create filter type for all column-having codecs
          for (const pgCodec of build.allPgCodecs) {
            if (!pgCodec.columns || pgCodec.isAnonymous) {
              continue;
            }
            const nodeTypeName = build.getGraphQLTypeNameByPgCodec(
              pgCodec,
              "output"
            );
            if (!nodeTypeName) continue;

            const filterTypeName = inflection.filterType(nodeTypeName);
            build.registerInputObjectType(
              filterTypeName,
              {
                pgCodec,
                isPgConnectionFilter: true,
              },
              () => ({
                description: `A filter to be used against \`${nodeTypeName}\` object types. All fields are combined with a logical ‘and.’`,
              }),
              "PgConnectionArgFilterPlugin"
            );
          }

          // Get or create types like IntFilter, StringFilter, etc.
          const codecsByFilterTypeName: {
            [typeName: string]: {
              isList: boolean;
              relatedTypeName: string;
              pgCodecs: PgTypeCodec<any, any, any, any>[];
              inputTypeName: string;
              rangeElementInputTypeName: string | null;
              domainBaseTypeName: string | null;
            };
          } = {};
          for (const codec of build.allPgCodecs) {
            const digest = build.connectionFilterOperatorsDigest(codec);
            if (!digest) {
              continue;
            }
            const {
              isList,
              operatorsTypeName,
              relatedTypeName,
              inputTypeName,
              rangeElementInputTypeName,
              domainBaseTypeName,
            } = digest;

            if (!codecsByFilterTypeName[operatorsTypeName]) {
              codecsByFilterTypeName[operatorsTypeName] = {
                isList,
                relatedTypeName,
                pgCodecs: [codec],
                inputTypeName,
                rangeElementInputTypeName,
                domainBaseTypeName,
              };
            } else {
              for (const key of [
                "isList",
                "relatedTypeName",
                "inputTypeName",
                "rangeElementInputTypeName",
              ]) {
                if (
                  digest[key] !== codecsByFilterTypeName[operatorsTypeName][key]
                ) {
                  throw new Error(
                    `${key} mismatch: existing codecs (${codecsByFilterTypeName[
                      operatorsTypeName
                    ].pgCodecs
                      .map((c) => c.name)
                      .join(", ")}) had ${key} = ${
                      codecsByFilterTypeName[operatorsTypeName][key]
                    }, but ${codec.name} instead has ${key} = ${digest[key]}`
                  );
                }
              }
              codecsByFilterTypeName[operatorsTypeName].pgCodecs.push(codec);
            }
          }

          for (const [
            operatorsTypeName,
            {
              isList,
              relatedTypeName,
              pgCodecs,
              inputTypeName,
              rangeElementInputTypeName,
              domainBaseTypeName,
            },
          ] of Object.entries(codecsByFilterTypeName)) {
            build.registerInputObjectType(
              operatorsTypeName,
              {
                pgConnectionFilterOperators: {
                  pgCodecs,
                  inputTypeName,
                  rangeElementInputTypeName,
                  domainBaseTypeName,
                },
                /*
              pgConnectionFilterOperatorsCategory,
              fieldType,
              fieldInputType,
              rangeElementInputType,
              domainBaseType,
              */
              },
              () => ({
                name: operatorsTypeName,
                description: `A filter to be used against ${relatedTypeName}${
                  isList ? " List" : ""
                } fields. All fields are combined with a logical ‘and.’`,
              }),
              "PgConnectionArgFilterPlugin"
            );
          }

          return _;
        },
      },

      // Add `filter` input argument to connection and simple collection types
      GraphQLObjectType_fields_field_args(args, build, context) {
        const {
          extend,
          getTypeByName,
          inflection,
          options: {
            connectionFilterAllowedFieldTypes,
            connectionFilterArrays,
            connectionFilterSetofFunctions,
            connectionFilterAllowNullInput,
            connectionFilterAllowEmptyObjectInput,
          },
        } = build;
        const {
          scope: {
            isPgFieldConnection,
            isPgFieldSimpleCollection,
            pgSource: source,
            fieldName,
          },
          Self,
        } = context;

        const shouldAddFilter =
          isPgFieldConnection || isPgFieldSimpleCollection;
        if (!shouldAddFilter) return args;

        if (!source) return args;
        const behavior = build.pgGetBehavior([
          source.codec.extensions,
          source.extensions,
        ]);

        // procedure sources aren't filterable by default (unless
        // connectionFilterSetofFunctions is set), but can be made filterable
        // by adding the `+filter` behavior.
        const defaultBehavior =
          source.parameters && !connectionFilterSetofFunctions
            ? "-filter"
            : "filter";

        if (!build.behavior.matches(behavior, "filter", defaultBehavior)) {
          return args;
        }

        const returnCodec = source.codec;
        const nodeType = build.getGraphQLTypeByPgCodec(
          returnCodec,
          "output"
        ) as GraphQLOutputType & GraphQLNamedType;
        if (!nodeType) {
          return args;
        }
        const nodeTypeName = nodeType.name;
        const filterTypeName = inflection.filterType(nodeTypeName);
        const nodeCodec = source.codec;

        const FilterType = build.getTypeByName(filterTypeName) as
          | GraphQLInputType
          | undefined;
        if (!FilterType) {
          return args;
        }

        return extend(
          args,
          {
            filter: {
              description:
                "A filter to be used in determining which values should be returned by the collection.",
              type: FilterType,
              ...(isPgFieldConnection
                ? {
                    plan(
                      _: any,
                      $connection: ConnectionStep<
                        any,
                        any,
                        any,
                        PgSelectStep<any, any, any, any>
                      >
                    ) {
                      const $pgSelect = $connection.getSubplan();
                      return $pgSelect.wherePlan();
                    },
                  }
                : {
                    plan(_: any, $pgSelect: PgSelectStep<any, any, any, any>) {
                      return $pgSelect.wherePlan();
                    },
                  }),
            },
          },
          `Adding connection filter arg to field '${fieldName}' of '${Self.name}'`
        );
      },
    },
  },
};

/*
export interface AddConnectionFilterOperator {
  (
    typeNames: string | string[],
    operatorName: string,
    description: string | null,
    resolveType: (
      fieldInputType: GraphQLInputType,
      rangeElementInputType: GraphQLInputType
    ) => GraphQLType,
    resolve: (
      sqlIdentifier: SQL,
      sqlValue: SQL,
      input: unknown,
      parentFieldName: string,
      queryBuilder: QueryBuilder
    ) => SQL | null,
    options?: {
      resolveInput?: (input: unknown) => unknown;
      resolveSqlIdentifier?: (
        sqlIdentifier: SQL,
        pgType: PgType,
        pgTypeModifier: number | null
      ) => SQL;
      resolveSqlValue?: (
        input: unknown,
        pgType: PgType,
        pgTypeModifier: number | null,
        resolveListItemSqlValue?: any
      ) => SQL | null;
    }
  ): void;
}

export default PgConnectionArgFilterPlugin;
*/
