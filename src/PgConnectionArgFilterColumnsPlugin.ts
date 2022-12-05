import {
  PgConditionLikeStep,
  PgSelectStep,
  PgTypeColumn,
  PgTypeColumns,
} from "@dataplan/pg";
import { ConnectionStep } from "grafast";

const { version } = require("../package.json");

export const PgConnectionArgFilterColumnsPlugin: GraphileConfig.Plugin = {
  name: "PgConnectionArgFilterColumnsPlugin",
  version,

  schema: {
    hooks: {
      GraphQLInputObjectType_fields(inFields, build, context) {
        let fields = inFields;
        const { extend, sql, inflection, connectionFilterOperatorsDigest } =
          build;
        const {
          fieldWithHooks,
          scope: { pgCodec: codec, isPgConnectionFilter },
          Self,
        } = context;

        if (!isPgConnectionFilter || !codec || !codec.columns) {
          return fields;
        }

        for (const [columnName, column] of Object.entries(
          codec.columns as PgTypeColumns
        )) {
          const behavior = build.pgGetBehavior([
            column.codec.extensions,
            column.extensions,
          ]);
          if (!build.behavior.matches(behavior, "filter", "filter")) {
            continue;
          }
          const colSpec = { columnName, column };
          const fieldName = inflection.column({ codec, columnName });
          const digest = connectionFilterOperatorsDigest(column.codec);
          if (!digest) {
            continue;
          }
          const OperatorsType = build.getTypeByName(digest.operatorsTypeName);
          if (!OperatorsType) {
            continue;
          }
          const {
            connectionFilterAllowEmptyObjectInput,
            connectionFilterAllowNullInput,
          } = build.options;
          fields = build.extend(
            fields,
            {
              [fieldName]: fieldWithHooks(
                {
                  fieldName,
                  isPgConnectionFilterField: true,
                },
                () => ({
                  description: `Filter by the object’s \`${fieldName}\` field.`,
                  type: OperatorsType,
                  applyPlan(
                    $connection: ConnectionStep<
                      any,
                      any,
                      PgSelectStep<any, any, any, any>,
                      any
                    >,
                    fieldArgs
                  ) {
                    const $raw = fieldArgs.getRaw();
                    if (
                      !connectionFilterAllowEmptyObjectInput &&
                      "evalIsEmpty" in $raw &&
                      $raw.evalIsEmpty()
                    ) {
                      throw Object.assign(
                        new Error(
                          "Empty objects are forbidden in filter argument input."
                        ),
                        {
                          //TODO: mark this error as safe
                        }
                      );
                    }
                    console.log("Check...");
                    if (!connectionFilterAllowNullInput) {
                      console.log("CHECK");
                    }
                    if (!connectionFilterAllowNullInput && $raw.evalIs(null)) {
                      throw Object.assign(
                        new Error(
                          "Null literals are forbidden in filter argument input."
                        ),
                        {
                          //TODO: mark this error as safe
                        }
                      );
                    }
                    const $select = $connection.getSubplan();
                    const $where = $select.wherePlan();
                    $where.extensions.pgFilterColumn = colSpec;
                    fieldArgs.apply($where);
                  },
                })
              ),
            },
            "Adding column-based filtering"
          );
        }

        return fields;
      },
    },
  },
};
